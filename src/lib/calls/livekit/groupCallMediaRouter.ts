import {GroupCallParticipant} from '@layer';
import getPeerId from '@appManagers/utils/peers/getPeerId';
import {GroupCallIdentity, parseGroupCallIdentity} from '@lib/calls/livekit/liveKitIdentity';
import type {LiveKitMediaSource, LiveKitRemoteTrackInfo} from '@lib/calls/livekit/liveKitTransport';

export type RoutedGroupCallTrack = {
  /**
   * The element and pin key. A camera or screen track (video, and the screen's audio) is keyed by its LiveKit
   * identity, which the server also hands out as `participant.video.endpoint` / `presentation.endpoint`; the
   * microphone is keyed by `participant.source`.
   */
  key: string,
  participant: GroupCallParticipant,
  peerId: PeerId,
  identity: string,
  sid: string,
  mediaSource: LiveKitMediaSource,
  kind: 'audio' | 'video',
  isPresentation: boolean,
  track: MediaStreamTrack
};

export type GroupCallMediaRouterOptions = {
  /** Called when a track has a participant and may be rendered. */
  onTrackRouted: (route: RoutedGroupCallTrack) => void,
  /** Called when a routed track went away (unsubscribed, or its participant left or changed source). */
  onTrackDropped: (route: RoutedGroupCallTrack) => void,
  /** The participants known so far (the manager cache). */
  getParticipants: () => Iterable<GroupCallParticipant>,
  /** Our own peer: tracks of our own identities are never rendered. */
  getSelfPeerId: () => PeerId | undefined
};


/** The participant a parsed LiveKit identity belongs to, per the mapping the backend defines. */
export function findIdentityParticipant(
  identity: GroupCallIdentity,
  participants: Iterable<GroupCallParticipant>
): GroupCallParticipant | undefined {
  for(const participant of participants) {
    if(getPeerId(participant.peer) !== identity.peerId || participant.pFlags.left) {
      continue;
    }

    const source: number | undefined = identity.isPresentation ? participant.presentation?.audio_source : participant.source;
    if(source !== undefined && source === identity.source) {
      return participant;
    }
  }

  return undefined;
}

/**
 * The element key a participant's `video` / `presentation` tile is rendered under: the row's `endpoint`, which
 * is exactly the LiveKit identity of the track that feeds the tile. Undefined while the row declares none.
 */
export function getParticipantOutputSource(
  participant: GroupCallParticipant,
  type: 'video' | 'presentation'
): string | undefined {
  return (type === 'video' ? participant.video : participant.presentation)?.endpoint || undefined;
}


/**
 * Turns LiveKit remote tracks into rendered participant media. A track whose participant row has not
 * arrived yet is parked under its identity and routed when the row shows up; a participant that left (or
 * rejoined under another source) takes its tracks with it.
 */
export default class GroupCallMediaRouter {
  private readonly routed = new Map<string, RoutedGroupCallTrack>();
  private readonly parked = new Map<string, Map<string, LiveKitRemoteTrackInfo>>();

  constructor(private readonly options: GroupCallMediaRouterOptions) {}


  public onRemoteTrack(info: LiveKitRemoteTrackInfo): void {
    const identity: GroupCallIdentity | undefined = parseGroupCallIdentity(info.identity);
    if(!identity || this.isOwn(identity)) {
      return;
    }

    const participant: GroupCallParticipant | undefined = findIdentityParticipant(identity, this.options.getParticipants());
    if(!participant) {
      this.park(info);
      return;
    }

    if(!participant.pFlags.self) {
      this.route(info, identity, participant);
    }
  }

  public onRemoteTrackRemoved(info: {identity: string, sid: string}): void {
    this.parked.get(info.identity)?.delete(info.sid);
    const route: RoutedGroupCallTrack | undefined = this.routed.get(info.sid);
    if(route) {
      this.routed.delete(info.sid);
      this.options.onTrackDropped(route);
    }
  }

  /** A participant row changed: route what was waiting for it, drop what no longer belongs to it. */
  public onParticipantUpdate(participant: GroupCallParticipant): void {
    const peerId: PeerId = getPeerId(participant.peer);
    for(const route of [...this.routed.values()]) {
      if(route.peerId !== peerId) {
        continue;
      }

      const identity: GroupCallIdentity = parseGroupCallIdentity(route.identity);
      const stillOwned: boolean = !participant.pFlags.left &&
        (route.isPresentation ? participant.presentation?.audio_source : participant.source) === identity.source;
      if(!stillOwned) {
        this.routed.delete(route.sid);
        this.options.onTrackDropped(route);
      } else {
        route.participant = participant;
      }
    }

    if(participant.pFlags.left || participant.pFlags.self) {
      this.dropParkedOfPeer(peerId);
      return;
    }

    for(const [identityString, tracks] of [...this.parked]) {
      const identity: GroupCallIdentity | undefined = parseGroupCallIdentity(identityString);
      if(!identity || identity.peerId !== peerId) {
        continue;
      }

      if(findIdentityParticipant(identity, [participant])) {
        this.parked.delete(identityString);
        for(const info of tracks.values()) {
          this.route(info, identity, participant);
        }
      }
    }
  }

  /** The routed video tracks, for per-tile quality. */
  public getVideoRoutes(): RoutedGroupCallTrack[] {
    return [...this.routed.values()].filter((route) => route.kind === 'video');
  }

  public getRoutes(): RoutedGroupCallTrack[] {
    return [...this.routed.values()];
  }

  public clear(): void {
    this.routed.clear();
    this.parked.clear();
  }


  private isOwn(identity: GroupCallIdentity): boolean {
    const selfPeerId: PeerId | undefined = this.options.getSelfPeerId();
    return selfPeerId !== undefined && identity.peerId === selfPeerId;
  }

  private park(info: LiveKitRemoteTrackInfo): void {
    const tracks = this.parked.get(info.identity) ?? new Map<string, LiveKitRemoteTrackInfo>();
    tracks.set(info.sid, info);
    this.parked.set(info.identity, tracks);
  }

  private dropParkedOfPeer(peerId: PeerId): void {
    for(const identityString of [...this.parked.keys()]) {
      if(parseGroupCallIdentity(identityString)?.peerId === peerId) {
        this.parked.delete(identityString);
      }
    }
  }

  private route(info: LiveKitRemoteTrackInfo, identity: GroupCallIdentity, participant: GroupCallParticipant): void {
    const isVideo: boolean = info.track.kind === 'video';
    const route: RoutedGroupCallTrack = {
      key: isVideo || identity.isPresentation ? info.identity : String(participant.source),
      participant,
      peerId: identity.peerId,
      identity: info.identity,
      sid: info.sid,
      mediaSource: info.source,
      kind: info.track.kind === 'video' ? 'video' : 'audio',
      isPresentation: identity.isPresentation,
      track: info.track
    };
    this.routed.set(info.sid, route);
    this.options.onTrackRouted(route);
  }
}
