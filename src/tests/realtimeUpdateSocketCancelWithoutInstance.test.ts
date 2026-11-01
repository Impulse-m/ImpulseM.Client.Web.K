import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import nodePath from 'node:path';
import {createRequire} from 'node:module';
import type {WebSocket, WebSocketServer as WebSocketServerType} from 'ws';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {protobufWireCodec} from './liveharness/realtimeWire';
import type {WireCodec, WireCommand} from './liveharness/realtimeWire';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * The update socket of a signed-in slot, driven through the REAL @impulsem/centrifuge client (no stub of the SDK) against a
 * Centrifugo-speaking server on loopback. The socket is built the way openSocket builds it: no `instance` option. apiManager
 * issues every call with an AbortSignal, so the call path must still send the call and settle a cancel locally.
 */

// Vite resolves `ws` to its browser shim; the node build is loaded by absolute path, as nodeEnv does.
const nodeRequire = createRequire(import.meta.url);
const wsModule = nodeRequire(nodePath.join(nodePath.dirname(nodeRequire.resolve('ws/package.json')), 'index.js'));
const WebSocketServer: typeof WebSocketServerType = wsModule.WebSocketServer ?? wsModule.default.WebSocketServer;

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

const origin: {url: string} = vi.hoisted(() => ({url: ''}));

vi.mock('@config/impulsemConfig', async(importActual) => {
  const actual = await importActual<typeof import('@config/impulsemConfig')>();
  return {...actual, backendUpdateWsOrigin: (): string => origin.url};
});

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const ACCOUNT: ActiveAccountNumber = 1;
const SESSION_TOKEN: string = 'access-jwt-cancel';
const ANSWERED_METHOD: string = 'help.getConfig';
const HELD_METHOD: string = 'updates.getDifference';
const ANSWER_BYTES: Uint8Array = new Uint8Array([7, 8, 9]);
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const CANCEL_SETTLE_MS: number = 1000;
// The connect flag of a server that understands RPC options (bit 32): a production Centrifugo answers with it.
const RPC_OPTIONS_CONNECT_FLAG: number = 2 ** 32;

type LoopbackServer = {
  server: WebSocketServerType,
  received: string[],
  held: Set<string>,
  codec: WireCodec
};

let loopback: LoopbackServer;

async function startLoopbackServer(): Promise<LoopbackServer> {
  const server: WebSocketServerType = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(server, 'listening');
  const address: AddressInfo = server.address() as AddressInfo;
  origin.url = `ws://127.0.0.1:${address.port}`;

  const codec: WireCodec = protobufWireCodec();
  const received: string[] = [];
  const held: Set<string> = new Set<string>([HELD_METHOD]);
  server.on('connection', (socket: WebSocket): void => {
    socket.on('message', (data: Buffer): void => {
      const replies: unknown[] = [];
      for(const command of codec.decodeCommands(data) as WireCommand[]) {
        if(command.connect) {
          replies.push({id: command.id, connect: {client: 'loopback-client', version: '1', flag: RPC_OPTIONS_CONNECT_FLAG}});
          continue;
        }

        if(command.rpc?.method === undefined) {
          continue;
        }

        received.push(command.rpc.method);
        if(held.has(command.rpc.method)) {
          continue;
        }

        replies.push({id: command.id, rpc: {data: ANSWER_BYTES}});
      }

      if(replies.length > 0) {
        socket.send(codec.encodeReplies(replies));
      }
    });
  });

  return {server, received, held, codec};
}

beforeAll(async() => {
  loopback = await startLoopbackServer();
});

afterAll(async() => {
  await new Promise<void>((resolve: () => void): void => {
    loopback.server.close((): void => resolve());
  });
});

beforeEach(async() => {
  vi.resetModules();
  loopback.received.length = 0;
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue({userId: 42, impulse_session_token: SESSION_TOKEN, impulse_refresh_token: 'refresh-token-cancel'});
  await registerSessionIdentitySource();
  const {restoreImpulseSession} = await import('@lib/impulse/session');
  await restoreImpulseSession(ACCOUNT);
});

afterEach(async() => {
  const realtime = await import('@lib/impulse/realtime');
  realtime.stopImpulseRealtime(ACCOUNT);
});

describe('a call on the update socket, which has no instance option, through the real SDK client', () => {
  it('is sent and resolves with the server reply, not refused as unsupported', async() => {
    const realtime = await import('@lib/impulse/realtime');
    const abortController: AbortController = new AbortController();

    const reply: Uint8Array = await realtime.callUpdateSocket({
      accountNumber: ACCOUNT,
      method: ANSWERED_METHOD,
      request: REQUEST_BYTES,
      signal: abortController.signal
    });

    expect(loopback.received, 'the server received the call').toEqual([ANSWERED_METHOD]);
    expect(reply).toEqual(ANSWER_BYTES);
  });

  it('rejects as CANCELED, promptly, when its signal aborts while the server holds the reply', async() => {
    const realtime = await import('@lib/impulse/realtime');
    const abortController: AbortController = new AbortController();

    const settled: Promise<unknown> = realtime.callUpdateSocket({
      accountNumber: ACCOUNT,
      method: HELD_METHOD,
      request: REQUEST_BYTES,
      signal: abortController.signal
    }).then(() => 'resolved', (error: unknown) => error);
    await vi.waitFor(() => expect(loopback.received, 'the held call reached the server').toContain(HELD_METHOD));
    const startedAt: number = Date.now();
    abortController.abort();

    const outcome: unknown = await Promise.race([
      settled,
      new Promise<string>((resolve: (value: string) => void): void => {
        setTimeout((): void => resolve('still pending'), CANCEL_SETTLE_MS);
      })
    ]);

    expect(outcome, 'the abort rejects the caller, and does not wait for the server').toMatchObject({type: 'CANCELED'});
    expect(Date.now() - startedAt, 'the cancel settles promptly').toBeLessThan(CANCEL_SETTLE_MS);
  });
});
