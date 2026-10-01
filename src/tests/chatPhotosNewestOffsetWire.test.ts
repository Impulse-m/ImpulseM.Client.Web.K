import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {describe, expect, it, vi} from 'vitest';

import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import {AppMessagesIdsManager} from '@appManagers/appMessagesIdsManager';
import {MESSAGE_ID_OFFSET} from '@appManagers/constants';
import {buildProtoInit} from '@lib/impulse/grpc/adapter';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import {SearchRequestSchema} from '@lib/impulse/grpc/gen/messages_pb';


/*
 * A broadcast channel's profile opens its avatar carousel with
 *   getHistory({offsetId: Number.MAX_SAFE_INTEGER, inputFilter: inputMessagesFilterChatPhotos})
 * (peerProfileAvatars.ts), and the media viewer pages from the fake current-avatar message whose
 * mid is the same sentinel (appMessagesManager.generateFakeAvatarMessage). Both mean "start from
 * the newest message", which canon spells offset_id = 0 (api/offsets: offset_id 0 = from the
 * most recent). requestHistory turned the sentinel into getServerMessageId(MAX_SAFE_INTEGER) =
 * 0xFFFFFFFF; MTProto's storeInt silently wrapped that to -1, the gRPC encoder refuses it:
 *   "serialize binary: cannot encode field v1.messages.SearchRequest.offset_id to binary:
 *    invalid int32" (owner's client, 2026-10-01 17:22:48, opening channel -749001).
 * The request is fed through the same stages grpcInvoke runs before it leaves
 * (buildProtoInit -> create -> toBinary).
 */
// * the history storage mirrors its slices to the main thread; there is none in a unit test
vi.spyOn(MTProtoMessagePort, 'getInstance').mockReturnValue({
  invokeVoid: vi.fn()
} as any);

const CHANNEL_ID = 749001 as ChatId;
const PEER_ID = CHANNEL_ID.toPeerId(true);

type CapturedCall = {method: string, params: any};

function makeManager(captured: CapturedCall[]) {
  const manager = new AppMessagesManager() as any;
  Object.assign(manager, {
    appPeersManager: {
      isPeerRestricted: () => false,
      getPeerMigratedTo: (): PeerId => undefined,
      getInputPeerById: () => ({_: 'inputPeerChannel', channel_id: CHANNEL_ID, access_hash: '1'}),
      isForum: () => false,
      isBotforum: () => false,
      isChannel: () => true
    },
    apiUpdatesManager: {addChannelState: () => {}},
    appMessagesIdsManager: new AppMessagesIdsManager(),
    searchesStorage: {},
    middleware: {get: () => () => true},
    getMigration: (): undefined => undefined,
    getMessageByPeer: (): undefined => undefined,
    getChannelAvailableMinIdGeneration: () => 0,
    saveApiResult: () => {},
    apiManager: {
      invokeApiSingleProcess: ({method, params}: any) => {
        captured.push({method, params});
        return Promise.resolve({
          _: 'messages.channelMessages',
          pFlags: {},
          pts: 4,
          count: 0,
          messages: [],
          topics: [],
          chats: [],
          users: []
        });
      }
    }
  });

  return manager;
}

function encodeSearch(params: any) {
  const request = create(SearchRequestSchema, buildProtoInit(params, SearchRequestSchema, {method: 'messages.search'}));
  return fromBinary(SearchRequestSchema, toBinary(SearchRequestSchema, request));
}

describe('chat photos requested from the newest message', () => {
  it('sends the avatar carousel\'s "from the newest" request as an encodable offset_id 0', async() => {
    const captured: CapturedCall[] = [];
    const manager = makeManager(captured);

    // * the literal options of peerProfileAvatars' chat branch
    await manager.getHistory({
      peerId: PEER_ID,
      offsetId: Number.MAX_SAFE_INTEGER,
      inputFilter: {_: 'inputMessagesFilterChatPhotos'},
      limit: 50,
      backLimit: 0
    });

    expect(captured.map((call) => call.method)).toEqual(['messages.search']);
    const decoded = encodeSearch(captured[0].params);
    expect(decoded.offsetId, 'the sentinel above every message is canon offset_id 0, never 0xFFFFFFFF').toBe(0);
  });

  it('keeps a real channel message offset as its server id', async() => {
    const captured: CapturedCall[] = [];
    const manager = makeManager(captured);

    await manager.getHistory({
      peerId: PEER_ID,
      // * the client mid of channel message 2
      offsetId: MESSAGE_ID_OFFSET + 2,
      inputFilter: {_: 'inputMessagesFilterChatPhotos'},
      limit: 50,
      backLimit: 0
    });

    expect(captured.map((call) => call.method)).toEqual(['messages.search']);
    expect(encodeSearch(captured[0].params).offsetId).toBe(2);
  });
});
