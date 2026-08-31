import {liveLane} from './lane';
import {PersonaSession} from './personaSession';
import {test} from './pair';

/*
 * Defect B pin (the #91/#93 family — "acked on the wire, never applied in the main thread"):
 * one persona sends ONE plain text message; within a bounded wait the sender's OWN bubble
 * must lose its pending state (is-outgoing/is-sending, temp mid) and carry a server mid, and
 * the dialog must appear in the sender's own chat list. The peer receiving it is NOT the
 * subject here — the reloadBothSides red already shows the peer receives fine while the
 * sender's side stays pending forever.
 *
 * On failure the scenario localizes which of the three hops died, from hooks installed
 * BEFORE the keystroke plus read-only probes taken at failure time:
 *
 *   hop 1 — RPC response: the page-side manager invoke (apiManagerProxy.invoke wrap) records
 *           whether appMessagesManager.sendText settled, and how;
 *   hop 2 — updates application: worker storage is probed for the finalized message (temp
 *           deleted, server-mid message present) and the page records whether the worker's
 *           'message_sent' event ever reached the main-thread rootScope;
 *   hop 3 — DOM rebind: the bubble's classes and data-mid, plus the chat-list row.
 *
 * Server truth comes from a RAW messages.getHistory through this very page's own connection
 * (the same seam invariants.ts documents), so "the server acked and holds the message" is
 * measured, not assumed from backend logs.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

type SendCall = {
  method: string,
  at: number,
  state: 'pending' | 'resolved' | 'rejected',
  settledAt: number,
  outcome: string
};

type MessageSentEvent = {
  tempId: string,
  mid: string,
  at: number
};

type BubbleState = {
  mid: string,
  serverId: number,
  classes: string
};

type RebindCapture = {
  peerId: string,
  bubbles: BubbleState[],
  serverMessages: {id: number, out: boolean}[],
  serverError: string,
  workerFinalProbes: {serverId: number, finalMid: number, workerHasFinal: boolean}[],
  workerTempProbes: {tempMid: string, workerStillHasTemp: boolean}[],
  dialogInList: boolean,
  sendCalls: SendCall[],
  messageSentEvents: MessageSentEvent[]
};


async function installSendHooks(session: PersonaSession): Promise<void> {
  await session.page.evaluate(() => {
    const w = window as any;
    const diag = {
      sendCalls: [] as any[],
      messageSentEvents: [] as any[]
    };
    w.__impulseSendDiag = diag;

    const renderOutcome = (value: any): string => {
      if(value instanceof Error) {
        return value.message;
      }
      try {
        return (JSON.stringify(value) ?? String(value)).slice(0, 400);
      } catch(ignored) {
        return String(value);
      }
    };

    // Hop-1 hook: every page->worker manager call funnels through apiManagerProxy.invoke
    // (getProxiedManagers.ts), so wrapping the mounted instance sees the UI's sendText and
    // its settlement. NOTE: attaching a rejection handler here would mask the app's own
    // unhandled rejection for this one call — accepted for this pinning scenario, and the
    // rejection is surfaced verbatim in the red instead.
    const originalInvoke = w.apiManagerProxy.invoke;
    w.apiManagerProxy.invoke = function(type: any, payload: any, ...rest: any[]) {
      const result = originalInvoke.call(this, type, payload, ...rest);
      if(type === 'manager' && payload?.name === 'appMessagesManager' && (payload?.method === 'sendText' || payload?.method === 'sendMessage')) {
        const entry = {method: payload.method, at: Date.now(), state: 'pending', settledAt: 0, outcome: ''};
        diag.sendCalls.push(entry);
        Promise.resolve(result).then(
          (value: any) => {
            entry.state = 'resolved';
            entry.settledAt = Date.now();
            entry.outcome = renderOutcome(value);
          },
          (error: any) => {
            entry.state = 'rejected';
            entry.settledAt = Date.now();
            entry.outcome = renderOutcome(error);
          }
        );
      }
      return result;
    };

    // Hop-2 hook: the worker dispatches 'message_sent' when it finalizes the pending
    // message (appMessagesManager.finalizePendingMessage); the page's rootScope mirrors it.
    w.rootScope.addEventListener('message_sent', (payload: any) => {
      diag.messageSentEvents.push({
        tempId: String(payload?.tempId),
        mid: String(payload?.mid),
        at: Date.now()
      });
    });
  });
}


async function captureRebindState(session: PersonaSession, needle: string): Promise<RebindCapture> {
  return session.page.evaluate(async(text) => {
    const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    const {default: getServerMessageId} = await dynamicImport('/src/lib/appManagers/utils/messageId/getServerMessageId.ts');

    const w = window as any;
    const chat = w.appImManager?.chat;
    const peerId = chat?.peerId;
    const container: HTMLElement | undefined = chat?.bubbles?.container;

    const bubbles = container ?
      Array.from(container.querySelectorAll<HTMLElement>('.bubble[data-mid]'))
        .filter((bubble) => bubble.textContent?.includes(text))
        .map((bubble) => ({
          mid: bubble.dataset.mid,
          serverId: getServerMessageId(+bubble.dataset.mid),
          classes: bubble.className
        })) :
      [];

    let serverMessages: {id: number, out: boolean}[] = [];
    let serverError = '';
    try {
      const inputPeer = await w.rootScope.managers.appPeersManager.getInputPeerById(peerId);
      const history = await w.rootScope.managers.apiManager.invokeApi('messages.getHistory', {
        peer: inputPeer,
        offset_id: 0,
        offset_date: 0,
        add_offset: 0,
        limit: 50,
        max_id: 0,
        min_id: 0,
        hash: 0
      });
      serverMessages = (history.messages ?? [])
        .filter((message: any) => message._ === 'message' && String(message.message ?? '').includes(text))
        .map((message: any) => ({id: message.id, out: !!message.pFlags?.out}));
    } catch(error: any) {
      serverError = error instanceof Error ? error.message : JSON.stringify(error);
    }

    const workerFinalProbes: {serverId: number, finalMid: number, workerHasFinal: boolean}[] = [];
    for(const serverMessage of serverMessages) {
      const finalMid = await w.rootScope.managers.appMessagesIdsManager.generateMessageId(serverMessage.id);
      const inWorker = await w.rootScope.managers.appMessagesManager.getMessageByPeer(peerId, finalMid);
      workerFinalProbes.push({serverId: serverMessage.id, finalMid, workerHasFinal: !!inWorker});
    }

    const workerTempProbes: {tempMid: string, workerStillHasTemp: boolean}[] = [];
    for(const bubble of bubbles) {
      if(bubble.serverId === 0) {
        const tempInWorker = await w.rootScope.managers.appMessagesManager.getMessageByPeer(peerId, +bubble.mid);
        workerTempProbes.push({tempMid: bubble.mid, workerStillHasTemp: !!tempInWorker});
      }
    }

    return {
      peerId: String(peerId),
      bubbles,
      serverMessages,
      serverError,
      workerFinalProbes,
      workerTempProbes,
      dialogInList: !!document.querySelector(`.chatlist-chat[data-peer-id="${peerId}"]`),
      sendCalls: w.__impulseSendDiag?.sendCalls ?? [],
      messageSentEvents: w.__impulseSendDiag?.messageSentEvents ?? []
    };
  }, needle);
}


function localizeRebindFailure(capture: RebindCapture): string {
  const rejectedCalls = capture.sendCalls.filter((call) => call.state === 'rejected');
  const pendingCalls = capture.sendCalls.filter((call) => call.state === 'pending');
  const serverHolds = capture.serverMessages.length > 0;
  const workerHasFinal = capture.workerFinalProbes.some((probe) => probe.workerHasFinal);
  const eventSeen = capture.messageSentEvents.length > 0;
  const domRebound = capture.bubbles.some((bubble) => {
    return Number.isInteger(bubble.serverId) && bubble.serverId >= 1 && !/is-outgoing|is-sending|is-error/.test(bubble.classes);
  });

  let hop: string;
  if(capture.sendCalls.length === 0) {
    hop = 'HOP 0: the UI never issued appMessagesManager.sendText through the manager proxy at all — the keystroke died before the RPC layer';
  } else if(!serverHolds) {
    hop = 'HOP 1 (RPC response): the server does NOT hold the message — the send never reached or never persisted on the server' +
      (rejectedCalls.length > 0 ? `; sendText REJECTED: ${JSON.stringify(rejectedCalls)}` : '') +
      (capture.serverError ? `; raw getHistory itself failed: ${capture.serverError}` : '');
  } else if(serverHolds && rejectedCalls.length > 0) {
    hop = 'HOP 1 (RPC response): the server PERSISTED the message (raw getHistory returns it) yet the client\'s ' +
      `sendText call REJECTED — the response lane returned an error for a call that succeeded server-side: ${JSON.stringify(rejectedCalls)}. ` +
      'The client then marks the pending message failed instead of finalizing it';
  } else if(!workerHasFinal) {
    hop = 'HOP 1/2 (RPC response / updates application inside the worker): the server holds the message but the client worker never finalized it — ' +
      'the temp message was never replaced by the server-mid message (finalizePendingMessage never ran), so the ack/updates were lost between the wire and the worker storage' +
      (rejectedCalls.length > 0 ? `; sendText REJECTED: ${JSON.stringify(rejectedCalls)}` : '') +
      (pendingCalls.length > 0 ? '; sendText invoke NEVER SETTLED on the page' : '');
  } else if(!eventSeen) {
    hop = 'HOP 2 (updates application to the main thread): the worker finalized the message (server mid present in worker storage) ' +
      'but message_sent was NEVER dispatched on the main-thread rootScope — the worker->page event mirror lost it';
  } else if(!domRebound) {
    hop = `HOP 3 (DOM rebind): message_sent reached the main thread (${JSON.stringify(capture.messageSentEvents)}) ` +
      'but the bubble kept its temp mid/pending classes — bubbles.ts never rebound it';
  } else if(!capture.dialogInList) {
    hop = 'HOP 3 (chat list): the bubble rebound but the dialog never appeared in the sender\'s own chat list';
  } else {
    hop = 'unclassified: every probed hop looks healthy although the assertion failed — the capture below is the evidence';
  }

  return [
    `LOCALIZATION: ${hop}`,
    `send calls: ${JSON.stringify(capture.sendCalls)}`,
    `message_sent events on the main thread: ${JSON.stringify(capture.messageSentEvents)}`,
    `server truth (raw getHistory over this page's connection): ${JSON.stringify(capture.serverMessages)}${capture.serverError ? ` (error: ${capture.serverError})` : ''}`,
    `worker storage, finalized: ${JSON.stringify(capture.workerFinalProbes)}`,
    `worker storage, still-temp: ${JSON.stringify(capture.workerTempProbes)}`,
    `bubbles containing the text: ${JSON.stringify(capture.bubbles)}`,
    `dialog in sender's chat list: ${capture.dialogInList}`
  ].join('\n');
}


test('a plain text send rebinds the sender\'s own bubble to the server message and lists the dialog', async({pair}) => {
  const {sender} = pair;
  const text = `rebind-${Date.now().toString(36)}`;

  await installSendHooks(sender);
  const sentAt = Date.now();
  await sender.typeAndSendText(text);

  // The rebind must hold as the STABLE end state over EVERY bubble carrying the text: a
  // server-mid bubble that flashes in (the inbound update echo) and vanishes again while the
  // temp bubble turns is-error is exactly the defect, and one transient settled frame must
  // not fake-pass it — run #1 of this scenario proved the echo produces such a frame while
  // the terminal state is the is-error temp bubble. So the poll resolves 'error' the moment
  // any text-carrying bubble goes is-error, resolves 'settled' only when every one carries an
  // INTEGER server mid >= 1 (temp mids on this fork are fractional: mid + 0.0001) without
  // pending classes, and a 'settled' verdict is re-sampled once 2s later and must still hold.
  // The mid helper is imported ONCE and stashed on window: waitForFunction does NOT await an
  // async predicate (the returned Promise is truthy on the first poll — run #2 of this
  // scenario proved it by "settling" 0.5s after the keystroke), so the poll predicate must
  // stay synchronous.
  await sender.page.evaluate(async() => {
    const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    const {default: getServerMessageId} = await dynamicImport('/src/lib/appManagers/utils/messageId/getServerMessageId.ts');
    (window as any).__impulseGetServerMessageId = getServerMessageId;
  });

  const sampleRebindState = async(): Promise<string> => {
    return sender.page.waitForFunction((needle) => {
      const getServerMessageId = (window as any).__impulseGetServerMessageId as (mid: number) => number;
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container || !getServerMessageId) {
        return false;
      }

      const bubbles = Array.from(container.querySelectorAll<HTMLElement>('.bubble[data-mid]'))
        .filter((bubble) => bubble.textContent?.includes(needle));
      if(bubbles.length === 0) {
        return false;
      }

      if(bubbles.some((bubble) => bubble.classList.contains('is-error'))) {
        return 'error';
      }

      const settled = bubbles.every((bubble) => {
        const serverId = getServerMessageId(+bubble.dataset.mid);
        return Number.isInteger(serverId) && serverId >= 1 &&
          !bubble.classList.contains('is-outgoing') &&
          !bubble.classList.contains('is-sending');
      });
      return settled ? 'settled' : false;
    }, text, {timeout: 45_000})
      // waitForFunction only resolves on a truthy value, so the handle is 'error' | 'settled'.
      .then((handle) => handle.jsonValue() as Promise<string>)
      .catch((): string => 'timeout');
  };

  let rebindState = await sampleRebindState();
  if(rebindState === 'settled') {
    await sender.page.waitForTimeout(2_000);
    rebindState = await sampleRebindState();
  }

  if(rebindState !== 'settled') {
    const capture = await captureRebindState(sender, text);
    throw new Error(
      'the sender\'s own message never became a real sent message: the bubble\'s terminal state ' +
      `is "${rebindState}" instead of a stable server-acked message — the user sees their text ` +
      'as eternally "sending" or failed with the error mark while the peer already received it ' +
      '(defect B, the #91/#93 family).\n' +
      localizeRebindFailure(capture) + '\n' +
      `console since the send:\n${sender.formatConsoleTrailSince(sentAt - 1_000)}`
    );
  }

  const dialogListed = await sender.page.waitForFunction(() => {
    const peerId = (window as any).appImManager?.chat?.peerId;
    return !!peerId && !!document.querySelector(`.chatlist-chat[data-peer-id="${peerId}"]`);
  }, undefined, {timeout: 20_000}).then(() => true).catch(() => false);

  if(!dialogListed) {
    const capture = await captureRebindState(sender, text);
    throw new Error(
      'the sender\'s bubble rebound to a server message, but the dialog never appeared in the ' +
      'sender\'s own chat list — the user sends a message and the conversation is missing from ' +
      'their list (the second user-visible half of defect B).\n' +
      localizeRebindFailure(capture) + '\n' +
      `console since the send:\n${sender.formatConsoleTrailSince(sentAt - 1_000)}`
    );
  }
});
