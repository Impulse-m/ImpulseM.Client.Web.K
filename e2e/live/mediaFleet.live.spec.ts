import {createHash} from 'crypto';

import type {Page} from '@playwright/test';

import {fleetAnswers, recordGatewayCalls} from './carriers';
import {liveLane} from './lane';
import {expect, test} from './pair';
import {downloadedDigest, sendDocument} from './documentTransfer';

/*
 * File transfer over the Centrifugo carriers, on the live lane. A two-part document goes up and comes down whole, the
 * update socket keeps delivering while it does, and every call of the transfer travels a carrier: the four file-transfer
 * calls the media fleet, the rest the update socket. No request reaches the gateway's gRPC-web paths.
 *
 * The spec skips, with the reason, when the dev stack publishes no media_only dcOption for this DC or a carrier does not
 * answer on its endpoint: the carriers are the server's to bring up.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

// A 512 KiB part is the client's minimum part size below 10 MiB (apiFileManager.getLimitPart), so this is two parts.
const TWO_PART_BYTES: number = 700 * 1024;
const DOCUMENT_NAME: string = 'two-part-transfer.bin';
const IN_FLIGHT_TEXT: string = 'delivered while the file moves';
const WEBSOCKET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';

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

async function fleetCounters(page: Page): Promise<{media: number, socket: number}> {
  return page.evaluate(() => (window as any).rootScope.managers.apiManager.getFleetCounters());
}

async function configOf(page: Page): Promise<FleetConfig> {
  return page.evaluate(() => (window as any).rootScope.managers.apiManager.getConfig());
}

function endpointOf(host: string, port: number): string {
  const origin = new URL(liveLane.gatewayOrigin);
  return `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${host}:${port}${WEBSOCKET_PATH}`;
}

test('a two-part file crosses the media fleet whole while the update socket delivers a message', async({pair}) => {
  const {sender, recipient} = pair;
  const payload = twoPartPayload();
  const expectedSha256 = createHash('sha256').update(payload).digest('hex');

  const senderConfig = await configOf(sender.page);
  const mediaOption = senderConfig.dc_options.find((option) => option.id === senderConfig.this_dc && option.pFlags?.media_only === true);
  test.skip(
    mediaOption === undefined,
    'the dev stack publishes no media_only dcOption for this DC: the file calls travel the update socket, and the media fleet has nothing to prove'
  );
  if(!mediaOption) {
    return;
  }

  const mediaUrl = endpointOf(mediaOption.ip_address, mediaOption.port);
  const socketUrl = `${liveLane.gatewayOrigin.replace(/^http/, 'ws')}${WEBSOCKET_PATH}`;
  const mediaProbe = await fleetAnswers(mediaUrl);
  test.skip(mediaProbe !== undefined, `the media fleet at ${mediaUrl} does not answer: ${mediaProbe}`);
  const socketProbe = await fleetAnswers(socketUrl);
  test.skip(socketProbe !== undefined, `the update socket at ${socketUrl} does not answer: ${socketProbe}`);

  const gatewayCalls: string[] = [];
  await recordGatewayCalls(sender.page, gatewayCalls);
  await recordGatewayCalls(recipient.page, gatewayCalls);

  await sendDocument(sender, payload, DOCUMENT_NAME);
  await recipient.typeAndSendText(IN_FLIGHT_TEXT);

  await sender.waitForIncomingText(IN_FLIGHT_TEXT);
  await sender.waitForOutgoingSettled('two-part document');
  await recipient.waitForIncomingText(DOCUMENT_NAME);

  const received = await downloadedDigest(recipient, DOCUMENT_NAME);
  expect(received.size, 'the downloaded document must be the whole two-part file').toBe(TWO_PART_BYTES);
  expect(received.sha256, 'the bytes downloaded must be the bytes uploaded').toBe(expectedSha256);

  const uploadedBy = await fleetCounters(sender.page);
  const downloadedBy = await fleetCounters(recipient.page);
  expect(uploadedBy.media, 'the upload parts must be carried by the media fleet').toBeGreaterThan(0);
  expect(uploadedBy.socket, 'the messages of the transfer must be carried by the update socket').toBeGreaterThan(0);
  expect(downloadedBy.media, 'the download must be carried by the media fleet').toBeGreaterThan(0);
  expect(gatewayCalls, 'no call of either client may travel the gateway gRPC-web paths').toEqual([]);
});
