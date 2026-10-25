import {expect, it} from 'vitest';
import pause from '@helpers/schedulers/pause';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack} from './managerStack';
import type {LiveStack} from './managerStack';
import {signInHeadless} from './authFlow';
import {ephemeralPersona, Persona} from './personas';
import {LostReplyWire} from './lostReplyWire';
import {MinimalRpcSession, openMinimalRpcSession} from './rpcDriver';
import {waitUntil} from './wait';


const CREATE_CHAT: string = 'messages.createChat';
const GET_DIALOGS: string = 'messages.getDialogs';
const DIALOGS_PAGE: Record<string, unknown> = {
  offset_date: 0,
  offset_id: 0,
  offset_peer: {_: 'inputPeerEmpty'},
  limit: 100,
  hash: '0'
};
const REPLY_WAIT_MS: number = 30_000;
const CHAT_WAIT_MS: number = 60_000;
const POLL_INTERVAL_MS: number = 250;

/** The same number, signed in once more: a last name other than the ephemeral one takes the account the number holds. */
function anotherSessionOf(persona: Persona): Persona {
  return {phone: persona.phone, firstName: persona.firstName, lastName: 'Session'};
}

async function countChatsTitled(session: MinimalRpcSession, title: string): Promise<number> {
  const dialogs: any = await session.invoke(GET_DIALOGS, DIALOGS_PAGE);
  return dialogs.chats.filter((chat: any): boolean => chat._ === 'chat' && chat.title === title).length;
}

async function waitForChatTitled(session: MinimalRpcSession, title: string): Promise<void> {
  const deadline: number = Date.now() + CHAT_WAIT_MS;
  while(await countChatsTitled(session, title) === 0) {
    if(Date.now() >= deadline) {
      throw new Error(`no chat titled "${title}" appeared on the second session within ${CHAT_WAIT_MS}ms`);
    }

    await pause(POLL_INTERVAL_MS);
  }
}


describeLive('update socket retransmits a call lost with its transport', () => {
  it('resolves the lost messages.createChat and creates one chat with its title', async() => {
    const wire: LostReplyWire = new LostReplyWire();
    const stack: LiveStack = await bootLiveManagerStack(liveLane.gatewayOrigin, {afterEnvInstalled: (): void => wire.install()});
    try {
      const persona: Persona = ephemeralPersona('UpdateSocketRetransmit');
      const {userId}: {userId: UserId} = await signInHeadless(stack, persona);
      const second: MinimalRpcSession = await openMinimalRpcSession(liveLane.gatewayOrigin, anotherSessionOf(persona));
      const title: string = `update-socket-retransmit-${Date.now()}`;

      wire.dropNextReplyOf(CREATE_CHAT);
      const created: Promise<{value?: any, error?: unknown}> = stack.managers.appChatsManager.createChat(title, [userId])
        .then((value: any): {value: any} => ({value}), (error: unknown): {error: unknown} => ({error}));
      await waitUntil((): true | undefined => wire.replyDropped() ? true : undefined, REPLY_WAIT_MS, 'the createChat reply to be lost');
      await waitForChatTitled(second, title);

      wire.closeDroppedSocket();
      const outcome: {value?: any, error?: unknown} = await created;

      expect(
        outcome.error,
        'the lost messages.createChat must resolve: the SDK sends a call lost with its transport again under its message ' +
        'id, and the server answers from the record of the first run (SDK README.md:338, :334)'
      ).toBeUndefined();
      expect(
        await countChatsTitled(second, title),
        'exactly one chat with the title must exist: a second run of the handler would create a second chat'
      ).toBe(1);
    } finally {
      await stack.dispose();
      wire.uninstall();
    }
  }, 240_000);
});
