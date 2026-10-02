import {fromImpulseMSource, toImpulseMSource} from '@lib/calls/utils';


/** `user` is `u`, `chat` is `c`, `channel` is `h` in the identity prefix. */
export type LiveKitPeerKind = 'user' | 'chat' | 'channel';

export type GroupCallIdentity = {
  kind: LiveKitPeerKind,
  /** Positive id for a user, negative id for a chat or a channel, as the client represents peers. */
  peerId: PeerId,
  /** Signed 32-bit source, the value of `groupCallParticipant.source`. */
  source: number,
  isPresentation: boolean
};

const PREFIX_BY_KIND: Record<LiveKitPeerKind, string> = {
  user: 'u',
  chat: 'c',
  channel: 'h'
};
const PRESENTATION_SUFFIX = '.p';
const MAX_PEER_ID = BigInt('9223372036854775807');
const MAX_UINT32 = 4294967295;
const CANONICAL_DIGITS = /^(0|[1-9][0-9]*)$/;


/**
 * Mirrors `LiveKitIdentities.ForGroupCall` / `ForGroupCallPresentation`:
 * `{u|c|h}{peerId}.{source}` with the source rendered unsigned, plus `.p` for the presentation.
 */
export function formatGroupCallIdentity(identity: GroupCallIdentity): string {
  const body = `${PREFIX_BY_KIND[identity.kind]}${Math.abs(identity.peerId)}.${fromImpulseMSource(identity.source)}`;
  return identity.isPresentation ? body + PRESENTATION_SUFFIX : body;
}

/**
 * Mirrors `LiveKitIdentities.TryParseGroupCall`: only canonical identities the server mints parse
 * (no leading zeros, no sign, source within uint32, one optional `.p`).
 */
export function parseGroupCallIdentity(identity: string | undefined | null): GroupCallIdentity | undefined {
  if(!identity) {
    return undefined;
  }

  const isPresentation: boolean = identity.endsWith(PRESENTATION_SUFFIX);
  const body: string = isPresentation ? identity.slice(0, -PRESENTATION_SUFFIX.length) : identity;
  if(body.length < 3) {
    return undefined;
  }

  const kind: LiveKitPeerKind | undefined = kindOfPrefix(body[0]);
  const separatorIndex: number = body.indexOf('.');
  if(!kind || separatorIndex < 2) {
    return undefined;
  }

  const peerDigits: string = body.slice(1, separatorIndex);
  const sourceDigits: string = body.slice(separatorIndex + 1);
  if(!CANONICAL_DIGITS.test(peerDigits) || !CANONICAL_DIGITS.test(sourceDigits)) {
    return undefined;
  }

  if(BigInt(peerDigits) > MAX_PEER_ID || !Number.isSafeInteger(Number(peerDigits))) {
    return undefined;
  }

  const unsignedSource: number = Number(sourceDigits);
  if(unsignedSource > MAX_UINT32) {
    return undefined;
  }

  const id: number = Number(peerDigits);
  return {
    kind,
    peerId: kind === 'user' ? id : -id,
    source: toImpulseMSource(unsignedSource),
    isPresentation
  };
}

/** A 1:1 identity is `u{userId}` and nothing else. Returns the user id, or undefined for any other shape. */
export function parsePhoneCallIdentity(identity: string | undefined | null): UserId | undefined {
  if(!identity || identity[0] !== PREFIX_BY_KIND.user) {
    return undefined;
  }

  const digits: string = identity.slice(1);
  if(!CANONICAL_DIGITS.test(digits) || !Number.isSafeInteger(Number(digits)) || digits === '0') {
    return undefined;
  }

  return Number(digits) as UserId;
}

export function formatPhoneCallIdentity(userId: UserId): string {
  return `${PREFIX_BY_KIND.user}${userId}`;
}


function kindOfPrefix(prefix: string): LiveKitPeerKind | undefined {
  switch(prefix) {
    case 'u':
      return 'user';
    case 'c':
      return 'chat';
    case 'h':
      return 'channel';
    default:
      return undefined;
  }
}
