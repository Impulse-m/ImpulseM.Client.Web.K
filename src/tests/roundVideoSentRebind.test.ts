import {describe, expect, it, vi} from 'vitest';

// CONTRACT — this module does not exist yet; the implementer extracts it from the
// `message_sent` round branch of src/components/chat/bubbles.ts (the
// `element.classList.contains('media-round')` arm) and wires bubbles.ts to call it:
//
//   // src/components/chat/utils/rebindRoundElementOnSent.ts
//   export default function rebindRoundElementOnSent(
//     element: HTMLElement,
//     message: Message.message
//   ): void
//
// It must repoint `(element as any).message` to the finalized message, set
// `element.dataset.mid` to the final mid, delete `element.dataset.isOutgoing`,
// and only THEN invoke `(element as DeferredMediaElement).onLoad(true)`.
import rebindRoundElementOnSent from '@components/chat/utils/rebindRoundElementOnSent';


// Shapes taken from the proven live bug: `generateTempMessageId`
// (src/lib/appManagers/appMessagesIdsManager.ts:12) mints fractional temp mids
// like 2578.0001, the pending document inherits that id as the string
// "2578.0001", and on `message_sent` the round branch of bubbles.ts updated
// dataset.mid but left `(element as any).message` pointing at the TEMP message.
// `onLoad` then fed the temp document — whose blob cache context had just been
// moved to the server document — into appMediaPlaybackController, a GetFile
// location was built with id "2578.0001", protobuf-es threw on BigInt("2578.0001"),
// and the sender's just-sent round note spun forever until a full page reload.
//
// This is an upstream tweb bug, and it detonates against real Telegram too,
// deterministically: worker mirror deletes and worker rootScope events travel
// over the SAME MTProtoMessagePort (src/lib/storages/thumbs.ts:82
// invokeVoid('mirror') and src/lib/rootScope.ts:302 invokeVoid('event')), so
// FIFO guarantees the temp doc's cache-context deletion is applied on main
// BEFORE the message_sent handler runs; addMedia resolves its deferred
// synchronously, so the download branch runs in a microtask before any further
// port message; and upstream's own MTProto storeLong
// (src/lib/mtproto/tl_utils.ts:166) calls bigInt("2578.0001"), which throws
// exactly like our protobuf-es path.
//
// Canonical behavior: after the server acknowledges a send, consumers must
// rebind to the FINAL message/document — tdlib's updateMessageSendSucceeded
// replaces the temp message including its file. The cache context that
// updateDocument moved lands under the final doc's key, so the rebound element
// plays the already-recorded local blob instantly instead of re-downloading.
const tempDocumentId = '2578.0001';
const finalDocumentId = '341952722011750787';
const serverIdShape = /^-?\d+$/;

function makeTempMessage(): any {
  return {
    _: 'message',
    id: 2578.0001,
    mid: 2578.0001,
    pFlags: {is_outgoing: true},
    media: {
      _: 'messageMediaDocument',
      document: {
        _: 'document',
        id: tempDocumentId,
        type: 'round'
      }
    }
  };
}

function makeFinalMessage(): any {
  return {
    _: 'message',
    id: 2578,
    mid: 2578,
    pFlags: {},
    media: {
      _: 'messageMediaDocument',
      document: {
        _: 'document',
        id: finalDocumentId,
        type: 'round'
      }
    }
  };
}

function makeRoundElement(tempMessage: any): {element: HTMLElement, onLoad: ReturnType<typeof vi.fn>, messagesSeenByOnLoad: any[]} {
  const element = document.createElement('div');
  element.classList.add('media-round');
  element.dataset.mid = String(tempMessage.mid);
  element.dataset.isOutgoing = '1';
  (element as any).message = tempMessage;

  const messagesSeenByOnLoad: any[] = [];
  const onLoad = vi.fn((autoload?: boolean) => {
    // Capture at call time: wrappers/video.ts reads `(divRound as any).message`
    // synchronously inside onLoad, so whatever `.message` points to at this
    // exact moment is what reaches appMediaPlaybackController.addMedia.
    messagesSeenByOnLoad.push((element as any).message);
  });
  (element as any).onLoad = onLoad;

  return {element, onLoad, messagesSeenByOnLoad};
}


describe('rebindRoundElementOnSent', () => {
  it('hands the finalized message to onLoad, never the temp one', () => {
    const tempMessage = makeTempMessage();
    const finalMessage = makeFinalMessage();
    const {element, onLoad, messagesSeenByOnLoad} = makeRoundElement(tempMessage);

    rebindRoundElementOnSent(element, finalMessage);

    expect(
      onLoad,
      'the round bubble defers its playback wiring until message_sent; if onLoad is not invoked exactly once on finalize, the sender\'s just-sent round note keeps its spinner forever'
    ).toHaveBeenCalledTimes(1);
    expect(
      onLoad,
      'bubbles.ts invoked onLoad(true) so the finalized round note autoloads; dropping the flag would leave the sender\'s bubble waiting for a manual click'
    ).toHaveBeenCalledWith(true);

    expect(
      messagesSeenByOnLoad[0],
      'onLoad read the TEMP message from the element: appMediaPlaybackController then resolves the temp document whose blob cache context was just moved away, builds a GetFile location with the fractional id, the BigInt encode throws, and the sender\'s round note spins forever'
    ).toBe(finalMessage);
    expect(
      messagesSeenByOnLoad[0]?.media?.document?.id,
      'the message visible to onLoad must carry the server document id; the temp document has no cache-context URL anymore (moveCacheContext took it), so anything else re-downloads via an unencodable id and spins forever'
    ).toBe(finalDocumentId);

    expect(
      (element as any).message,
      'the element must keep pointing at the finalized message after the send; every later reader (replay, media viewer, playback controller) would otherwise resurrect the dead temp document'
    ).toBe(finalMessage);
    expect(
      element.dataset.mid,
      'dataset.mid must be the final mid so later bubble queries by mid find the sent round note instead of a ghost temp id'
    ).toBe(String(finalMessage.mid));
    expect(
      'isOutgoing' in element.dataset,
      'dataset.isOutgoing must be removed on finalize; a round note still marked outgoing keeps its pending affordances after the server accepted it'
    ).toBe(false);
  });

  it('leaves no fractional temp id on any surface of the element after rebind', () => {
    const tempMessage = makeTempMessage();
    const finalMessage = makeFinalMessage();
    const {element} = makeRoundElement(tempMessage);

    rebindRoundElementOnSent(element, finalMessage);

    // Invariant, not sample: a document id whose string form is not a plain
    // decimal integer is a client-local temp id and can never be encoded into a
    // GetFile request — if one survives anywhere on the element, the next media
    // load dies in the serializer and the sender sees the eternal spinner.
    const datasetEntries = Object.entries({...element.dataset});
    for(const [key, value] of datasetEntries) {
      expect(
        value,
        `element.dataset.${key} still carries the fractional temp id after rebind; any consumer resolving media by it builds an unencodable GetFile request and the round note spins forever`
      ).not.toBe(tempDocumentId);
      expect(
        value,
        `element.dataset.${key} still carries the temp mid after rebind; any consumer resolving media by it targets the dead temp record and the round note spins forever`
      ).not.toBe(String(tempMessage.mid));
    }

    const reachableDocumentId = (element as any).message?.media?.document?.id;
    expect(
      String(reachableDocumentId),
      'the document id reachable from the element must be a server id (plain decimal integer string); a fractional temp id cannot be encoded into InputDocumentFileLocation.id and every download of it rejects, spinning forever'
    ).toMatch(serverIdShape);
    expect(
      String(element.dataset.mid),
      'dataset.mid must be an integer mid after finalize; a fractional mid marks the element as still pending and playback wiring never resolves it'
    ).toMatch(serverIdShape);

    const strayDoc = (element as any).doc;
    if(strayDoc?.id !== undefined) {
      expect(
        String(strayDoc.id),
        'a `doc` reference left on the element must also carry a server id; a temp doc kept here feeds the playback controller an id the serializer rejects'
      ).toMatch(serverIdShape);
    }
  });
});
