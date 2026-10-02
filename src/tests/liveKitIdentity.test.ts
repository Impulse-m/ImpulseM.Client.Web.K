import {describe, expect, it} from 'vitest';
import {
  formatGroupCallIdentity,
  formatPhoneCallIdentity,
  GroupCallIdentity,
  LiveKitPeerKind,
  parseGroupCallIdentity,
  parsePhoneCallIdentity
} from '@lib/calls/livekit/liveKitIdentity';

// Vectors ported from LiveKitNamingTests.cs (ImpulseM.Messages.UnitTests/LiveKit).
describe('liveKitIdentity', () => {
  it('names the 1:1 identity as the user alone', () => {
    expect(formatPhoneCallIdentity(77 as UserId)).toBe('u77');
    expect(parsePhoneCallIdentity('u77')).toBe(77);
  });

  it.each([
    [undefined],
    [''],
    ['77'],
    ['u'],
    ['u0'],
    ['u077'],
    ['u77.5'],
    ['u-5'],
    ['c77'],
    ['u77 ']
  ])('rejects %j as a 1:1 identity', (identity: string | undefined) => {
    expect(parsePhoneCallIdentity(identity)).toBeUndefined();
  });

  it.each<[LiveKitPeerKind, number, number, string]>([
    ['user', 77, 5, 'u77.5'],
    ['chat', -1001, 0, 'c1001.0'],
    ['channel', -2002, -1, 'h2002.4294967295'],
    ['user', 1, -2147483648, 'u1.2147483648']
  ])('renders the source unsigned and round-trips %s %d %d', (kind, peerId, source, expected) => {
    const identity: GroupCallIdentity = {kind, peerId: peerId as PeerId, source, isPresentation: false};
    expect(formatGroupCallIdentity(identity)).toBe(expected);
    expect(parseGroupCallIdentity(expected)).toEqual(identity);
  });

  it('carries the presentation suffix and round-trips', () => {
    const identity: GroupCallIdentity = {kind: 'channel', peerId: -2002 as PeerId, source: -1, isPresentation: true};
    expect(formatGroupCallIdentity(identity)).toBe('h2002.4294967295.p');
    expect(parseGroupCallIdentity('h2002.4294967295.p')).toEqual(identity);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['u77'],
    ['u77.'],
    ['u.5'],
    ['x77.5'],
    ['u77.s5'],
    ['u77.-5'],
    ['u77.4294967296'],
    ['u077.5'],
    ['u77.05'],
    ['u77.5.q'],
    ['u77.5.p.p'],
    ['u9223372036854775808.5'],
    ['u77.5 ']
  ])('rejects %j as a group-call identity', (identity: string | undefined | null) => {
    expect(parseGroupCallIdentity(identity)).toBeUndefined();
  });

  it('accepts the largest uint32 source and a zero source', () => {
    expect(parseGroupCallIdentity('u1.4294967295')?.source).toBe(-1);
    expect(parseGroupCallIdentity('u1.0')?.source).toBe(0);
  });
});
