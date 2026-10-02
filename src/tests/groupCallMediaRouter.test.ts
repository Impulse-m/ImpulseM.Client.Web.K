import {beforeEach, describe, expect, it} from 'vitest';
import '@helpers/peerIdPolyfill';
import {GroupCallParticipant} from '@layer';
import GroupCallMediaRouter, {
  findIdentityParticipant,
  getParticipantOutputSource,
  RoutedGroupCallTrack
} from '@lib/calls/livekit/groupCallMediaRouter';
import {formatGroupCallIdentity} from '@lib/calls/livekit/liveKitIdentity';
import type {LiveKitMediaSource, LiveKitRemoteTrackInfo} from '@lib/calls/livekit/liveKitTransport';

type PeerKind = 'user' | 'chat' | 'channel';

function participant(options: {
  kind?: PeerKind,
  id: number,
  source: number,
  presentationSource?: number,
  left?: boolean,
  self?: boolean
}): GroupCallParticipant {
  const kind: PeerKind = options.kind ?? 'user';
  const peer = kind === 'user' ?
    {_: 'peerUser', user_id: options.id} :
    kind === 'chat' ? {_: 'peerChat', chat_id: options.id} : {_: 'peerChannel', channel_id: options.id};
  return {
    _: 'groupCallParticipant',
    pFlags: {...(options.left ? {left: true} : {}), ...(options.self ? {self: true} : {})},
    peer,
    date: 0,
    source: options.source,
    ...(options.presentationSource !== undefined ? {
      presentation: {_: 'groupCallParticipantVideo', pFlags: {}, endpoint: `presentation-${options.presentationSource}`, source_groups: [], audio_source: options.presentationSource}
    } : {})
  } as unknown as GroupCallParticipant;
}

function identityOf(options: {kind?: PeerKind, id: number, source: number, presentation?: boolean}): string {
  const kind: PeerKind = options.kind ?? 'user';
  return formatGroupCallIdentity({
    kind,
    peerId: (kind === 'user' ? options.id : -options.id) as PeerId,
    source: options.source,
    isPresentation: !!options.presentation
  });
}

function trackInfo(options: {identity: string, sid: string, source: LiveKitMediaSource}): LiveKitRemoteTrackInfo {
  const kind = options.source === 'camera' || options.source === 'screen' ? 'video' : 'audio';
  return {
    identity: options.identity,
    sid: options.sid,
    source: options.source,
    track: {kind} as unknown as MediaStreamTrack,
    muted: false
  };
}

let participants: GroupCallParticipant[];
let routed: RoutedGroupCallTrack[];
let dropped: RoutedGroupCallTrack[];
let router: GroupCallMediaRouter;

beforeEach(() => {
  participants = [];
  routed = [];
  dropped = [];
  router = new GroupCallMediaRouter({
    getParticipants: () => participants,
    getSelfPeerId: () => 1 as PeerId,
    onTrackRouted: (route) => routed.push(route),
    onTrackDropped: (route) => dropped.push(route)
  });
});

describe('findIdentityParticipant', () => {
  it('matches a main identity by peer and source, and a presentation identity by audio_source', () => {
    const user = participant({id: 7, source: 100, presentationSource: 200});
    expect(findIdentityParticipant({kind: 'user', peerId: 7 as PeerId, source: 100, isPresentation: false}, [user])).toBe(user);
    expect(findIdentityParticipant({kind: 'user', peerId: 7 as PeerId, source: 200, isPresentation: true}, [user])).toBe(user);
    expect(findIdentityParticipant({kind: 'user', peerId: 7 as PeerId, source: 200, isPresentation: false}, [user])).toBeUndefined();
    expect(findIdentityParticipant({kind: 'user', peerId: 7 as PeerId, source: 100, isPresentation: true}, [user])).toBeUndefined();
    expect(findIdentityParticipant({kind: 'user', peerId: 8 as PeerId, source: 100, isPresentation: false}, [user])).toBeUndefined();
  });

  it('does not match a participant that left', () => {
    const gone = participant({id: 7, source: 100, left: true});
    expect(findIdentityParticipant({kind: 'user', peerId: 7 as PeerId, source: 100, isPresentation: false}, [gone])).toBeUndefined();
  });

  it('matches chats and channels by their negative peer id', () => {
    const chat = participant({kind: 'chat', id: 55, source: 1});
    const channel = participant({kind: 'channel', id: 66, source: 2});
    expect(findIdentityParticipant({kind: 'chat', peerId: -55 as PeerId, source: 1, isPresentation: false}, [chat, channel])).toBe(chat);
    expect(findIdentityParticipant({kind: 'channel', peerId: -66 as PeerId, source: 2, isPresentation: false}, [chat, channel])).toBe(channel);
  });
});

describe('getParticipantOutputSource', () => {
  it('is the participant source for the camera and the presentation audio source for the screen', () => {
    const user = participant({id: 7, source: 100, presentationSource: 200});
    expect(getParticipantOutputSource(user, 'video')).toBe(100);
    expect(getParticipantOutputSource(user, 'presentation')).toBe(200);
    expect(getParticipantOutputSource(participant({id: 8, source: 5}), 'presentation')).toBeUndefined();
  });
});

describe('GroupCallMediaRouter', () => {
  it('routes a user microphone and camera under the participant source', () => {
    const user = participant({id: 7, source: 100});
    participants.push(user);

    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'A', source: 'microphone'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'V', source: 'camera'}));

    expect(routed.map((route) => [route.key, route.kind, route.mediaSource, route.participant, route.isPresentation])).toEqual([
      ['100', 'audio', 'microphone', user, false],
      ['100', 'video', 'camera', user, false]
    ]);
    expect(router.getVideoRoutes().map((route) => route.sid)).toEqual(['V']);
  });

  it('routes chat and channel identities to their participants', () => {
    participants.push(participant({kind: 'chat', id: 55, source: 1}), participant({kind: 'channel', id: 66, source: 2}));

    router.onRemoteTrack(trackInfo({identity: identityOf({kind: 'chat', id: 55, source: 1}), sid: 'C', source: 'microphone'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({kind: 'channel', id: 66, source: 2}), sid: 'H', source: 'microphone'}));

    expect(routed.map((route) => [route.peerId, route.key])).toEqual([[-55, '1'], [-66, '2']]);
  });

  it('routes a presentation under presentation.audio_source, screen video and screen audio alike', () => {
    participants.push(participant({id: 7, source: 100, presentationSource: 200}));

    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 200, presentation: true}), sid: 'S', source: 'screen'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 200, presentation: true}), sid: 'SA', source: 'screenAudio'}));

    expect(routed.map((route) => [route.key, route.kind, route.isPresentation])).toEqual([
      ['200', 'video', true],
      ['200', 'audio', true]
    ]);
  });

  it('parks a track whose participant row has not arrived and routes it when the row does', () => {
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'A', source: 'microphone'}));
    expect(routed).toHaveLength(0);

    router.onParticipantUpdate(participant({id: 8, source: 5}));
    expect(routed).toHaveLength(0);

    const user = participant({id: 7, source: 100});
    participants.push(user);
    router.onParticipantUpdate(user);

    expect(routed.map((route) => route.sid)).toEqual(['A']);
    router.onParticipantUpdate(user);
    expect(routed).toHaveLength(1);
  });

  it('keeps a presentation track parked until the presentation appears in the row', () => {
    const user = participant({id: 7, source: 100});
    participants.push(user);
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 200, presentation: true}), sid: 'S', source: 'screen'}));
    expect(routed).toHaveLength(0);

    const withPresentation = participant({id: 7, source: 100, presentationSource: 200});
    participants[0] = withPresentation;
    router.onParticipantUpdate(withPresentation);

    expect(routed.map((route) => route.key)).toEqual(['200']);
  });

  it('drops the tracks of a participant that left and forgets what was parked for it', () => {
    const user = participant({id: 7, source: 100});
    participants.push(user);
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'A', source: 'microphone'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 999}), sid: 'P', source: 'microphone'}));

    router.onParticipantUpdate(participant({id: 7, source: 100, left: true}));

    expect(dropped.map((route) => route.sid)).toEqual(['A']);
    participants[0] = participant({id: 7, source: 999});
    router.onParticipantUpdate(participants[0]);
    expect(routed.map((route) => route.sid)).toEqual(['A']);
  });

  it('drops a route when the participant rejoined under another source', () => {
    participants.push(participant({id: 7, source: 100}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'A', source: 'microphone'}));

    router.onParticipantUpdate(participant({id: 7, source: 101}));

    expect(dropped.map((route) => route.sid)).toEqual(['A']);
    expect(router.getRoutes()).toHaveLength(0);
  });

  it('removes a routed track on unsubscribe and forgets a parked one', () => {
    participants.push(participant({id: 7, source: 100}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'A', source: 'microphone'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 8, source: 5}), sid: 'B', source: 'microphone'}));

    router.onRemoteTrackRemoved({identity: identityOf({id: 7, source: 100}), sid: 'A'});
    router.onRemoteTrackRemoved({identity: identityOf({id: 8, source: 5}), sid: 'B'});
    const later = participant({id: 8, source: 5});
    participants.push(later);
    router.onParticipantUpdate(later);

    expect(dropped.map((route) => route.sid)).toEqual(['A']);
    expect(routed.map((route) => route.sid)).toEqual(['A']);
  });

  it('ignores our own identities, presentation included, and ones the server never mints', () => {
    participants.push(participant({id: 1, source: 10, presentationSource: 20, self: true}));

    router.onRemoteTrack(trackInfo({identity: identityOf({id: 1, source: 20, presentation: true}), sid: 'OWN_P', source: 'screen'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 1, source: 10}), sid: 'OWN', source: 'microphone'}));
    router.onRemoteTrack(trackInfo({identity: 'not-an-identity', sid: 'X', source: 'microphone'}));

    expect(routed).toHaveLength(0);
    router.onParticipantUpdate(participant({id: 1, source: 10, self: true}));
    expect(routed).toHaveLength(0);
  });

  it('exposes a snapshot copy of the routes and clears everything', () => {
    participants.push(participant({id: 7, source: 100}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 7, source: 100}), sid: 'A', source: 'microphone'}));
    router.onRemoteTrack(trackInfo({identity: identityOf({id: 8, source: 5}), sid: 'B', source: 'microphone'}));

    router.clear();

    expect(router.getRoutes()).toEqual([]);
    const later = participant({id: 8, source: 5});
    participants.push(later);
    router.onParticipantUpdate(later);
    expect(routed.map((route) => route.sid)).toEqual(['A']);
  });
});
