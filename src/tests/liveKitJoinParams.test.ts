import {describe, expect, it} from 'vitest';
import {
  groupCallRoomName,
  LiveKitParamsError,
  LiveKitParamsErrorCode,
  parseLiveKitJoinParams,
  phoneCallRoomName
} from '@lib/calls/livekit/liveKitJoinParams';

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TOKEN: string = `${base64Url({alg: 'HS256', typ: 'JWT'})}.${base64Url({sub: 'u1001', exp: 1790000000})}.signature`;

function data(document: unknown): {_: 'dataJSON', data: string} {
  return {_: 'dataJSON', data: typeof document === 'string' ? document : JSON.stringify(document)};
}

function codeOf(run: () => unknown): LiveKitParamsErrorCode | undefined {
  try {
    run();
  } catch(err) {
    expect(err).toBeInstanceOf(LiveKitParamsError);
    return (err as LiveKitParamsError).code;
  }

  return undefined;
}

describe('liveKitJoinParams', () => {
  it('names the rooms the way the backend does', () => {
    expect(phoneCallRoomName('9007199254740993')).toBe('p.9007199254740993');
    expect(groupCallRoomName('42')).toBe('g.42');
  });

  it('parses the exact document LiveKitJoinParameters writes', () => {
    const wire: string = `{"livekit":{"url":"wss://impulsem.livekit.cloud","token":"${TOKEN}","room":"p.123"}}`;
    expect(parseLiveKitJoinParams({params: data(wire), expectedRoom: 'p.123'})).toEqual({
      url: 'wss://impulsem.livekit.cloud',
      token: TOKEN,
      room: 'p.123',
      expiresAt: 1790000000
    });
  });

  it('accepts a plain ws url and leaves expiresAt out of an opaque token', () => {
    const parsed = parseLiveKitJoinParams({
      params: data({livekit: {url: 'ws://localhost:7880', token: 'opaque', room: 'g.7'}}),
      expectedRoom: 'g.7'
    });
    expect(parsed).toEqual({url: 'ws://localhost:7880', token: 'opaque', room: 'g.7'});
  });

  it('reports MISSING without params, without data and without a livekit key', () => {
    expect(codeOf(() => parseLiveKitJoinParams({params: undefined, expectedRoom: 'p.1'}))).toBe('LIVEKIT_PARAMS_MISSING');
    expect(codeOf(() => parseLiveKitJoinParams({params: data(''), expectedRoom: 'p.1'}))).toBe('LIVEKIT_PARAMS_MISSING');
    expect(codeOf(() => parseLiveKitJoinParams({params: data({ssrc: 5}), expectedRoom: 'p.1'}))).toBe('LIVEKIT_PARAMS_MISSING');
    expect(codeOf(() => parseLiveKitJoinParams({params: data({livekit: null}), expectedRoom: 'p.1'}))).toBe('LIVEKIT_PARAMS_MISSING');
  });

  it('reports INVALID for bad JSON, wrong shapes, empty or non-string fields', () => {
    const good = {url: 'wss://a.example', token: 't', room: 'p.1'};
    const invalid = (document: unknown) => codeOf(() => parseLiveKitJoinParams({params: data(document), expectedRoom: 'p.1'}));
    expect(invalid('{not json')).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid('[1]')).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid('"x"')).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid({livekit: 'x'})).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid({livekit: [good]})).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid({livekit: {...good, url: ''}})).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid({livekit: {...good, token: 5}})).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid({livekit: {...good, room: undefined}})).toBe('LIVEKIT_PARAMS_INVALID');
  });

  it('reports INVALID for a url that is not ws or wss', () => {
    const good = {token: 't', room: 'p.1'};
    const invalid = (url: string) => codeOf(() => parseLiveKitJoinParams({
      params: data({livekit: {...good, url}}),
      expectedRoom: 'p.1'
    }));
    expect(invalid('https://a.example')).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid('javascript:alert(1)')).toBe('LIVEKIT_PARAMS_INVALID');
    expect(invalid('not a url')).toBe('LIVEKIT_PARAMS_INVALID');
  });

  it('reports ROOM_MISMATCH for coordinates of another room', () => {
    const run = () => parseLiveKitJoinParams({
      params: data({livekit: {url: 'wss://a.example', token: 't', room: 'p.2'}}),
      expectedRoom: 'p.1'
    });
    expect(codeOf(run)).toBe('LIVEKIT_ROOM_MISMATCH');
    expect(() => run()).toThrow(/LIVEKIT_ROOM_MISMATCH/);
  });
});
