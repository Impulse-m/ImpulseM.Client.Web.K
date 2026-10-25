import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {FleetIdentity} from '@lib/impulse/fleet/fleet';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import type {UpdateSocketHarness, UpdateSocketStub} from './helpers/updateSocketStub';

/*
 * The update socket's SDK instance is a random secret, fresh per socket, never logged (SDK README.md:372).
 * Without it, a call lost with its transport is not sent again (SDK README.md:352).
 */

const {loggedArguments} = vi.hoisted(() => ({loggedArguments: [] as unknown[][]}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: sockets} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: sockets().CentrifugeStub};
});

vi.mock('@lib/impulseLogger', () => {
  const record = (...args: unknown[]): void => {
    loggedArguments.push(args);
  };

  return {
    getLogger: () => ({debug: record, info: record, warn: record, error: record}),
    setLogAuthTokenProvider: vi.fn()
  };
});

const INSTANCE_FORM: RegExp = /^[A-Za-z0-9_-]{22}$/;
const ACCOUNT_A: ActiveAccountNumber = 1;
const ACCOUNT_B: ActiveAccountNumber = 2;
const GET_CONFIG: string = 'help.getConfig';
const TOKEN_EXPIRED: number = 109;

const socketHarness: UpdateSocketHarness = sharedUpdateSocketHarness();

let refusals: unknown[][] = [];

async function registerIdentity(): Promise<void> {
  const {setFleetIdentitySource} = await import('@lib/impulse/fleet/fleet');
  const identity: FleetIdentity = {
    kind: 'identity',
    key: 'identity:fixture',
    getToken: async(): Promise<string> => 'connection-identity-token',
    onRefused: (...args: unknown[]): void => {
      refusals.push(args);
    }
  };
  setFleetIdentitySource(() => identity);
}

beforeEach(async() => {
  vi.resetModules();
  socketHarness.reset();
  loggedArguments.length = 0;
  refusals = [];
  await registerIdentity();
});

describe('update socket instance (SDK README.md:372)', () => {
  it('opens the update socket with a 22-character base64url client instance', async() => {
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');

    realtime.startImpulseRealtime('user-A', ACCOUNT_A);

    expect(socketHarness.sockets.length, 'the slot must open one update socket').toBe(1);
    expect(
      socketHarness.sockets[0].options.instance ?? 'no instance',
      'the update socket must be built with an instance of 22 base64url characters, or the SDK never retransmits a lost call'
    ).toMatch(INSTANCE_FORM);
  });

  it('gives each update socket its own instance', async() => {
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');

    realtime.startImpulseRealtime('user-A', ACCOUNT_A);
    realtime.startImpulseRealtime('user-B', ACCOUNT_B);

    const [socketOne, socketTwo]: UpdateSocketStub[] = socketHarness.sockets;
    expect(socketOne.options.instance ?? 'no instance', 'the first socket must carry an instance').toMatch(INSTANCE_FORM);
    expect(socketTwo.options.instance ?? 'no instance', 'the second socket must carry an instance').toMatch(INSTANCE_FORM);
    expect(
      socketTwo.options.instance,
      'two sockets sharing one instance would share one retransmit scope, so each socket needs its own instance'
    ).not.toBe(socketOne.options.instance);
  });

  it('never writes the instance to a log or to a failure report', async() => {
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');
    socketHarness.respond(GET_CONFIG, (): never => {
      throw {code: TOKEN_EXPIRED, message: 'token expired'};
    });

    realtime.startImpulseRealtime('user-A', ACCOUNT_A);
    const socket: UpdateSocketStub = socketHarness.sockets[0];
    const failure: unknown = await realtime.callUpdateSocket({accountNumber: ACCOUNT_A, method: GET_CONFIG, request: new Uint8Array(0)})
      .then((): undefined => undefined, (error: unknown): unknown => error);
    expect(failure, 'the refused call must reject with the refusal, or the failure path under test never runs').toMatchObject({type: 'AUTH_TOKEN_EXPIRED'});

    socket.emit('error', {error: {code: TOKEN_EXPIRED, message: 'token expired'}});
    socket.emit('connecting', {code: 0, reason: 'connect called'});
    socket.emit('connected', {transport: 'websocket'});
    socket.emit('disconnected', {code: 4100, reason: 'refused'});
    socket.emit('publication', {channel: 'user:user-A', data: {oversize: true, type: 1}});
    for(const subscription of socket.subscriptions) {
      subscription.emit('error', {error: {code: 1, message: 'timeout'}});
      subscription.emit('subscribing', {code: 0, reason: 'subscribe called'});
      subscription.emit('subscribed', {recoverable: true, wasRecovering: false, recovered: false});
      subscription.emit('unsubscribed', {code: 0, reason: 'unsubscribe called'});
      subscription.emit('publication', {data: {oversize: true, type: 1}});
    }

    const instance: string = socket.options.instance;
    expect(instance ?? 'no instance', 'the scan below needs the socket\'s instance').toMatch(INSTANCE_FORM);
    expect(refusals.length, 'the refusal path must run, or the scan proves nothing').toBeGreaterThan(0);
    expect(loggedArguments.length, 'the socket events must reach the logger, or the scan proves nothing').toBeGreaterThan(0);

    const captured: string = JSON.stringify({logged: loggedArguments, failures: refusals});
    expect(captured, 'the instance must not appear in any log argument or failure payload').not.toContain(instance);
  });
});
