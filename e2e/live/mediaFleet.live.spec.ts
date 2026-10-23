import {createHash} from 'crypto';

import type {Page, Request} from '@playwright/test';

import {liveLane} from './lane';
import {expect, test} from './pair';
import type {PersonaSession} from './personaSession';

/*
 * File transfer over the Centrifugo fleets, on the live lane. A two-part document goes up and comes down whole, the
 * update socket keeps delivering while it does, and every call of the transfer travels a fleet: the four file-transfer
 * calls the media fleet, the rest the RPC fleet. No request reaches the gateway's gRPC-web paths.
 *
 * The spec skips, with the reason, when the dev stack publishes no media_only dcOption for this DC or a fleet does not
 * answer on its endpoint: the fleets are the server's to bring up.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

// A 512 KiB part is the client's minimum part size below 10 MiB (apiFileManager.getLimitPart), so this is two parts.
const TWO_PART_BYTES: number = 700 * 1024;
const DOCUMENT_NAME: string = 'two-part-transfer.bin';
const IN_FLIGHT_TEXT: string = 'delivered while the file moves';
const PROBE_TIMEOUT_MS: number = 5_000;
const WEBSOCKET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
// The gateway's gRPC-web paths: /v1.{namespace}.{Service}/{Method}.
const GRPC_WEB_PATH: RegExp = /\/v1\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/;

type FleetConfig = {
  this_dc: number,
  dc_options: Array<{id: number, ip_address: string, port: number, pFlags?: {ipv6?: boolean, media_only?: boolean}}>
};

function twoPartPayload(): Uint8Array {
  const payload = new Uint8Array(TWO_PART_BYTES);
  for(let i = 0; i < payload.length; ++i) {
    payload[i] = (i * 31 + 7) & 0xff;
  }

  return payload;
}

async function fleetCounters(page: Page): Promise<{media: number, rpc: number}> {
  return page.evaluate(() => (window as any).rootScope.managers.apiManager.getFleetCounters());
}

async function configOf(page: Page): Promise<FleetConfig> {
  return page.evaluate(() => (window as any).rootScope.managers.apiManager.getConfig());
}

function endpointOf(host: string, port: number): string {
  const origin = new URL(liveLane.gatewayOrigin);
  return `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${host}:${port}${WEBSOCKET_PATH}`;
}

/** Whether a fleet answers its WebSocket within the probe timeout, from the test runner. */
async function fleetAnswers(url: string): Promise<string | undefined> {
  const WebSocketClass = (globalThis as any).WebSocket;
  return new Promise<string | undefined>((resolve: (reason: string | undefined) => void): void => {
    const socket = new WebSocketClass(url);
    const timer = setTimeout((): void => {
      socket.close();
      resolve(`no answer within ${PROBE_TIMEOUT_MS} ms`);
    }, PROBE_TIMEOUT_MS);
    socket.onopen = (): void => {
      clearTimeout(timer);
      socket.close();
      resolve(undefined);
    };
    socket.onerror = (): void => {
      clearTimeout(timer);
      resolve('the connection was refused');
    };
  });
}

function recordGatewayCalls(page: Page, into: string[]): void {
  page.on('request', (request: Request): void => {
    const url = new URL(request.url());
    if(GRPC_WEB_PATH.test(url.pathname)) {
      into.push(url.pathname);
    }
  });
}

async function sendTwoPartDocument(sender: PersonaSession, payload: Uint8Array): Promise<void> {
  await sender.page.evaluate(async({bytes, name}) => {
    const w = window as any;
    const chat = w.appImManager.chat;
    if(!chat?.peerId) {
      throw new Error('the two-part send was requested with no open dialog');
    }

    const file = new File([Uint8Array.from(bytes)], name, {type: 'application/octet-stream'});
    await w.rootScope.managers.appMessagesManager.sendFile({
      ...chat.getMessageSendingParams(),
      file,
      isMedia: false,
      clearDraft: true
    });
  }, {bytes: Array.from(payload), name: DOCUMENT_NAME});
}

async function downloadedDigest(recipient: PersonaSession): Promise<{size: number, sha256: string}> {
  return recipient.page.evaluate(async(name: string) => {
    const w = window as any;
    const chat = w.appImManager.chat;
    const history = await w.rootScope.managers.appMessagesManager.getHistory({peerId: chat.peerId, limit: 20});
    const messages: any[] = await Promise.all((history?.history ?? []).map((mid: number) =>
      w.rootScope.managers.appMessagesManager.getMessageByPeer(chat.peerId, mid)
    ));
    const message = messages.find((entry: any) => entry?.media?.document?.file_name === name);
    if(!message) {
      throw new Error(`no document named ${name} is in the recipient's dialog`);
    }

    const blob: Blob = await w.rootScope.managers.appDocsManager.downloadDoc(message.media.document);
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (byte: number): string => byte.toString(16).padStart(2, '0')).join('');
    return {size: blob.size, sha256};
  }, DOCUMENT_NAME);
}

test('a two-part file crosses the media fleet whole while the update socket delivers a message', async({pair}) => {
  const {sender, recipient} = pair;
  const payload = twoPartPayload();
  const expectedSha256 = createHash('sha256').update(payload).digest('hex');

  const senderConfig = await configOf(sender.page);
  const mediaOption = senderConfig.dc_options.find((option) => option.id === senderConfig.this_dc && option.pFlags?.media_only === true);
  test.skip(
    mediaOption === undefined,
    'the dev stack publishes no media_only dcOption for this DC: the file calls travel the RPC fleet, and the media fleet has nothing to prove'
  );
  if(!mediaOption) {
    return;
  }

  const mediaUrl = endpointOf(mediaOption.ip_address, mediaOption.port);
  const rpcOption = senderConfig.dc_options.find((option) => option.id === senderConfig.this_dc && option.pFlags?.media_only !== true);
  const rpcUrl = rpcOption ? endpointOf(rpcOption.ip_address, rpcOption.port) : endpointOf(new URL(liveLane.gatewayOrigin).hostname, 443);
  const mediaProbe = await fleetAnswers(mediaUrl);
  test.skip(mediaProbe !== undefined, `the media fleet at ${mediaUrl} does not answer: ${mediaProbe}`);
  const rpcProbe = await fleetAnswers(rpcUrl);
  test.skip(rpcProbe !== undefined, `the RPC fleet at ${rpcUrl} does not answer: ${rpcProbe}`);

  const gatewayCalls: string[] = [];
  recordGatewayCalls(sender.page, gatewayCalls);
  recordGatewayCalls(recipient.page, gatewayCalls);

  await sendTwoPartDocument(sender, payload);
  await recipient.typeAndSendText(IN_FLIGHT_TEXT);

  await sender.waitForIncomingText(IN_FLIGHT_TEXT);
  await sender.waitForOutgoingSettled('two-part document');
  await recipient.waitForIncomingText(DOCUMENT_NAME);

  const received = await downloadedDigest(recipient);
  expect(received.size, 'the downloaded document must be the whole two-part file').toBe(TWO_PART_BYTES);
  expect(received.sha256, 'the bytes downloaded must be the bytes uploaded').toBe(expectedSha256);

  const uploadedBy = await fleetCounters(sender.page);
  const downloadedBy = await fleetCounters(recipient.page);
  expect(uploadedBy.media, 'the upload parts must be carried by the media fleet').toBeGreaterThan(0);
  expect(uploadedBy.rpc, 'the messages of the transfer must be carried by the RPC fleet').toBeGreaterThan(0);
  expect(downloadedBy.media, 'the download must be carried by the media fleet').toBeGreaterThan(0);
  expect(gatewayCalls, 'no call of either client may travel the gateway gRPC-web paths').toEqual([]);
});
