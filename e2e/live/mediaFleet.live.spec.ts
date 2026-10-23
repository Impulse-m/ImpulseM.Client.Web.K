import {createHash} from 'crypto';

import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import type {Page, Route} from '@playwright/test';

import {ConfigSchema, DcOptionSchema} from '../../src/lib/impulse/grpc/gen/v1/types_pb';
import {liveLane} from './lane';
import {expect, test} from './pair';
import type {PersonaSession} from './personaSession';

/*
 * File transfer over the media fleet, on the live lane. A two-part document goes up and comes down whole,
 * and the update socket keeps delivering while it does.
 *
 * The dev stack publishes no media_only dcOption yet (tests/ImpulseM.Smokes/Fixtures/LiveStackFixture.cs:322),
 * so the help.getConfig reply is rewritten in each page to carry one for this DC, the way a published option
 * would arrive. The fleet host is media.impulsem.io:443.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

const MEDIA_HOST: string = 'media.impulsem.io';
const MEDIA_PORT: number = 443;
const GET_CONFIG_ROUTE: string = '**/v1.help.Help/GetConfig';
// A 512 KiB part is the client's minimum part size below 10 MiB (apiFileManager.getLimitPart), so this is two parts.
const TWO_PART_BYTES: number = 700 * 1024;
const GRPC_WEB_HEADER_BYTES: number = 5;
const GRPC_WEB_DATA_FLAG: number = 0;
const DOCUMENT_NAME: string = 'two-part-transfer.bin';
const IN_FLIGHT_TEXT: string = 'delivered while the file moves';

function twoPartPayload(): Uint8Array {
  const payload = new Uint8Array(TWO_PART_BYTES);
  for(let i = 0; i < payload.length; ++i) {
    payload[i] = (i * 31 + 7) & 0xff;
  }

  return payload;
}

function addMediaOption(message: Uint8Array): Uint8Array {
  const config = fromBinary(ConfigSchema, message);
  config.dcOptions.push(create(DcOptionSchema, {
    id: config.thisDc,
    ipAddress: MEDIA_HOST,
    port: MEDIA_PORT,
    mediaOnly: true
  }));

  return toBinary(ConfigSchema, config);
}

// Each gRPC-web frame is a flag byte and a big-endian length, then the message. Only data frames carry a Config.
function rewriteDataFrames(body: Uint8Array, rewrite: (message: Uint8Array) => Uint8Array): Uint8Array {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: Uint8Array[] = [];
  let offset = 0;
  while(offset < body.byteLength) {
    const flag = view.getUint8(offset);
    const length = view.getUint32(offset + 1);
    const payload = body.subarray(offset + GRPC_WEB_HEADER_BYTES, offset + GRPC_WEB_HEADER_BYTES + length);
    const message = flag === GRPC_WEB_DATA_FLAG ? rewrite(payload) : payload;

    const frame = new Uint8Array(GRPC_WEB_HEADER_BYTES + message.byteLength);
    const frameView = new DataView(frame.buffer);
    frameView.setUint8(0, flag);
    frameView.setUint32(1, message.byteLength);
    frame.set(message, GRPC_WEB_HEADER_BYTES);
    frames.push(frame);
    offset += GRPC_WEB_HEADER_BYTES + length;
  }

  const total = frames.reduce((sum: number, frame: Uint8Array): number => sum + frame.byteLength, 0);
  const out = new Uint8Array(total);
  let written = 0;
  for(const frame of frames) {
    out.set(frame, written);
    written += frame.byteLength;
  }

  return out;
}

async function publishMediaOption(page: Page): Promise<void> {
  await page.route(GET_CONFIG_ROUTE, async(route: Route) => {
    const response = await route.fetch();
    const body = rewriteDataFrames(new Uint8Array(await response.body()), addMediaOption);
    const headers: Record<string, string> = {...response.headers()};
    delete headers['content-length'];
    await route.fulfill({status: response.status(), headers, body: Buffer.from(body)});
  });

  await page.evaluate(() => (window as any).rootScope.managers.apiManager.getConfig(true));
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

  await publishMediaOption(sender.page);
  await publishMediaOption(recipient.page);

  await sendTwoPartDocument(sender, payload);
  await recipient.typeAndSendText(IN_FLIGHT_TEXT);

  await sender.waitForIncomingText(IN_FLIGHT_TEXT);
  await sender.waitForOutgoingSettled('two-part document');
  await recipient.waitForIncomingText(DOCUMENT_NAME);

  const received = await downloadedDigest(recipient);
  expect(received.size, 'the downloaded document must be the whole two-part file').toBe(TWO_PART_BYTES);
  expect(received.sha256, 'the bytes downloaded must be the bytes uploaded').toBe(expectedSha256);
});
