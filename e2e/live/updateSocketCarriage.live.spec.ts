import {createHash} from 'crypto';

import type {Page} from '@playwright/test';

import {fleetAnswers, recordGatewayCalls} from './carriers';
import {downloadedDigest, sendDocument} from './documentTransfer';
import {liveLane} from './lane';
import {expect, test} from './pair';

/*
 * The calls of a signed-in pair travel the update socket, on the live lane: a message is sent and read back, its history
 * is read, and a small file is transferred. Every call is counted on the Centrifugo carriers of each page, and no request
 * of either page reaches the gateway's gRPC-web paths.
 *
 * The spec skips, with the reason, when the update socket of the dev stack does not answer: the server brings it up.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

const WEBSOCKET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
const MESSAGE_TEXT: string = 'carried by the update socket';
const DOCUMENT_NAME: string = 'carried-by-the-update-socket.bin';
const DOCUMENT_BYTES: number = 4 * 1024;

async function fleetCounters(page: Page): Promise<{media: number, socket: number}> {
  return page.evaluate(() => (window as any).rootScope.managers.apiManager.getFleetCounters());
}

function documentPayload(): Uint8Array {
  const payload = new Uint8Array(DOCUMENT_BYTES);
  for(let i = 0; i < payload.length; ++i) {
    payload[i] = (i * 17 + 3) & 0xff;
  }

  return payload;
}

test('a message, its history and a file travel the update socket, and no page reaches the gateway gRPC-web paths', async({pair}) => {
  const {sender, recipient} = pair;
  const socketUrl = `${liveLane.gatewayOrigin.replace(/^http/, 'ws')}${WEBSOCKET_PATH}`;
  const probe = await fleetAnswers(socketUrl);
  test.skip(probe !== undefined, `the update socket at ${socketUrl} does not answer: ${probe}`);

  const gatewayCalls: string[] = [];
  await recordGatewayCalls(sender.page, gatewayCalls);
  await recordGatewayCalls(recipient.page, gatewayCalls);

  await sender.typeAndSendText(MESSAGE_TEXT);
  await recipient.waitForIncomingText(MESSAGE_TEXT);

  const payload = documentPayload();
  const expectedSha256 = createHash('sha256').update(payload).digest('hex');
  await sendDocument(sender, payload, DOCUMENT_NAME);
  await recipient.waitForIncomingText(DOCUMENT_NAME);

  const readBack = await recipient.page.evaluate(async() => {
    const w = window as any;
    const history = await w.rootScope.managers.appMessagesManager.getHistory({peerId: w.appImManager.chat.peerId, limit: 20});
    const messages: any[] = await Promise.all((history?.history ?? []).map((mid: number) =>
      w.rootScope.managers.appMessagesManager.getMessageByPeer(w.appImManager.chat.peerId, mid)
    ));
    return messages.map((entry: any) => entry?.message ?? '');
  });
  expect(readBack, 'the recipient reads the message back in the history of the dialog').toContain(MESSAGE_TEXT);

  const received = await downloadedDigest(recipient, DOCUMENT_NAME);
  expect(received.size, 'the downloaded file is the file that was sent').toBe(DOCUMENT_BYTES);
  expect(received.sha256, 'the bytes downloaded are the bytes uploaded').toBe(expectedSha256);

  const sentBy = await fleetCounters(sender.page);
  const readBy = await fleetCounters(recipient.page);
  expect(sentBy.socket, 'the sender\'s calls must be carried by the update socket').toBeGreaterThan(0);
  expect(readBy.socket, 'the recipient\'s calls must be carried by the update socket').toBeGreaterThan(0);
  expect(gatewayCalls, 'no request of either page may travel the gateway gRPC-web paths').toEqual([]);
});
