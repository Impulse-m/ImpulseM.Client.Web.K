import {expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona} from './personas';


/*
 * B1: the group manager must be able to load its data.
 *
 * CEO, live, 2026-09-10: "я не могу открыть менеджера группы, я не могу ей управлять", with
 *
 *   worker task error: {type: "NETWORKER_DISABLED"}
 *     getNetworker@apiManager.ts:405
 *     invokeApi@apiManager.ts:766
 *     invokeApiSingleProcess@apiManagerMethods.ts:110
 *     getJoinedCommunities@appCommunitiesManager.ts:429
 *   open tab error: {type: "NETWORKER_DISABLED"}
 *
 * The tab loads its data as ONE Promise.all of five legs
 * (src/components/sidebarRight/tabs/editChat.tsx:76-96, upstream and unmodified):
 *
 *   getChatFull, getChat, getAppConfig, getAvailableReactions, getJoinedCommunities
 *
 * so any one leg that rejects takes the whole tab with it — `createResource` errors and the
 * `<Show when={data()}>` body never renders. Four of those legs work. The fifth calls
 * `communities.getJoinedCommunities`, and this fork's bridge has no mapping for the
 * `communities` namespace, so `isGrpcAvailable` answers false and the call continues into the
 * MTProto networker that this deployment deliberately refuses
 * (apiManager.ts:487-494, "every request reaches the gateway over gRPC ... Refuse up front").
 *
 * That refusal is correct. The defect is that an unmapped method reaches it at all: a missing
 * mapping is not a loud failure at the boundary, it is a feature that dies somewhere else.
 *
 * Asserted on the manager seam rather than through a browser because the manager graph is
 * where the rejection is produced; the tab is only the first screen that happens to await it.
 * The whole five-leg load is driven here, not just the failing leg, so this stays a test about
 * OPENING THE GROUP MANAGER and does not quietly narrow into a test about one RPC.
 */
const bootTimeoutMs = 120_000;


describeLive('B1 group manager: the edit-chat tab can load its data for a group the account owns', () => {
  it('resolves every leg of the edit-chat loader, so the tab renders instead of erroring', async() => {
    const rejections = new UnhandledRejectionGuard();
    rejections.install();

    let stack: LiveStack | undefined;
    try {
      stack = await bootLiveManagerStack(liveLane.gatewayOrigin);
      await signInHeadless(stack, ephemeralPersona('GroupManagerOpens'));

      const managers = stack.managers;

      const title = `GroupManagerOpens-${Date.now()}`;
      const {chatId} = await managers.appChatsManager.createChat(title, []);

      // The exact five legs of loadEditChatData, in the same shape: one Promise.all, so a
      // single rejection is the whole tab. Named individually below so a failure says WHICH
      // leg died rather than "the tab did not open".
      const legs: Array<[string, Promise<unknown>]> = [
        ['appProfileManager.getChatFull', managers.appProfileManager.getChatFull(chatId, true)],
        ['appChatsManager.getChat', managers.appChatsManager.getChat(chatId)],
        ['apiManager.getAppConfig', managers.apiManager.getAppConfig()],
        ['appReactionsManager.getAvailableReactions', managers.appReactionsManager.getAvailableReactions()],
        ['appCommunitiesManager.getJoinedCommunities', managers.appCommunitiesManager.getJoinedCommunities()]
      ];

      const outcomes = await Promise.allSettled(legs.map(([, promise]) => promise));
      const failed = outcomes
        .map((outcome, index) => ({name: legs[index][0], outcome}))
        .filter(({outcome}) => outcome.status === 'rejected')
        .map(({name, outcome}) => `${name}: ${describeRejection((outcome as PromiseRejectedResult).reason)}`);

      expect(failed, [
        'The edit-chat tab awaits these five as ONE Promise.all (editChat.tsx:80-86), so every',
        'name listed here is a reason the group manager does not open at all.',
        '',
        'NETWORKER_DISABLED means the method has no gRPC mapping in',
        'src/lib/impulse/grpc/serviceMap.ts and fell through to the MTProto transport this',
        'deployment does not serve. That is a backend/bridge gap, not a client one: editChat.tsx',
        'is upstream code and calls exactly what canon declares.'
      ].join('\n')).toEqual([]);
    } finally {
      await stack?.dispose?.();
      rejections.assertNone('group manager load');
      rejections.uninstall();
    }
  }, bootTimeoutMs);
});


function describeRejection(reason: any): string {
  if(reason && typeof reason === 'object') {
    return reason.type || reason.message || JSON.stringify(reason);
  }
  return String(reason);
}
