import {createHash, randomBytes} from 'crypto';

import {expect, test} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {attachAsFileThroughUi, documentRow, ownDocumentRow, waitForDocumentRow} from './documentRow';
import {downloadedDigest} from './documentTransfer';
import {liveLane} from './lane';
import type {MediaPayload} from './mediaFixtures';
import {PersonaSession} from './personaSession';

const mebibyte: number = 1024 * 1024;
const smallTransferBytes: number = 20 * mebibyte;
const largeTransferBytes: number = 100 * mebibyte;
const transferSettleTimeoutMs: number = 900_000;
const rowQuietTimeoutMs: number = 120_000;
const scenarioTimeoutMs: number = 900_000;

test.skip(!liveLane.enabled, liveLane.skipReason);

type TransferResult = {
  label: string,
  bytes: number,
  seconds: number,
  mebibytesPerSecond: number
};

function randomPayload(name: string, sizeBytes: number): MediaPayload {
  return {
    name,
    mimeType: 'application/octet-stream',
    buffer: randomBytes(sizeBytes)
  };
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function mebibytesPerSecond(measurement: {bytes: number, seconds: number}): number {
  return measurement.bytes / mebibyte / measurement.seconds;
}

async function waitForCompleteOwnRow(session: PersonaSession): Promise<void> {
  await waitForDocumentRow(session, ownDocumentRow);
  await session.page.waitForFunction((selector: string) => {
    const rows = document.querySelectorAll(selector);
    const element = rows.length > 0 ? rows[rows.length - 1] : undefined;
    if(!element) {
      return false;
    }

    return !Array.from(element.querySelectorAll('.preloader-container')).some((preloader) => {
      const rect = preloader.getBoundingClientRect();
      const style = getComputedStyle(preloader);
      return rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        parseFloat(style.opacity) > 0.01;
    });
  }, ownDocumentRow.selector, {timeout: rowQuietTimeoutMs});

  await expect(documentRow(session.page, ownDocumentRow)).toBeVisible();
}

async function sendAndMeasure(session: PersonaSession, payload: MediaPayload): Promise<TransferResult> {
  const startedAt = Date.now();
  await attachAsFileThroughUi(session, [payload], transferSettleTimeoutMs);
  await waitForCompleteOwnRow(session).catch((error: Error) => {
    throw new Error(
      `${payload.name} (${payload.buffer.length} bytes) never became a complete file row on the sender's page; ` +
      `the sending bubble settled or vanished without one: ${error.message}\n` +
      `console since the attach:\n${session.formatConsoleTrailSince(startedAt)}`
    );
  });
  const seconds: number = (Date.now() - startedAt) / 1000;
  const bytes: number = payload.buffer.length;

  const result: TransferResult = {
    label: payload.name,
    bytes,
    seconds,
    mebibytesPerSecond: mebibytesPerSecond({bytes, seconds})
  };
  console.log(
    `[upload] ${result.label}: ${(result.bytes / mebibyte).toFixed(0)} MiB in ${result.seconds.toFixed(2)} s = ` +
    `${result.mebibytesPerSecond.toFixed(2)} MiB/s`
  );

  return result;
}

test('a 20 MiB and a 100 MiB document sent to Saved Messages complete, and the 20 MiB one downloads back byte for byte', async({browser}, testInfo) => {
  testInfo.setTimeout(scenarioTimeoutMs);

  const session: PersonaSession = await PersonaSession.open(browser, ephemeralPersona(`saved-${testInfo.testId}`));
  try {
    await session.signUpThroughUi();
    await session.openSavedMessages();

    const nonce: string = Date.now().toString(36);
    const smallName: string = `saved-20mib-${nonce}.bin`;
    const largeName: string = `saved-100mib-${nonce}.bin`;
    const smallPayload: MediaPayload = randomPayload(smallName, smallTransferBytes);
    const largePayload: MediaPayload = randomPayload(largeName, largeTransferBytes);
    const smallSha256: string = sha256Hex(smallPayload.buffer);

    await sendAndMeasure(session, smallPayload);
    await sendAndMeasure(session, largePayload);

    const downloadStartedAt: number = Date.now();
    const received: {size: number, sha256: string} = await downloadedDigest(session, smallName);
    const downloadSeconds: number = (Date.now() - downloadStartedAt) / 1000;
    console.log(
      `[download] ${smallName}: ${(received.size / mebibyte).toFixed(0)} MiB in ${downloadSeconds.toFixed(2)} s = ` +
      `${mebibytesPerSecond({bytes: received.size, seconds: downloadSeconds}).toFixed(2)} MiB/s`
    );

    expect(received.size, 'the 20 MiB document came back with a different size than it was sent with').toBe(smallTransferBytes);
    expect(received.sha256, 'the 20 MiB document came back with a different SHA-256 than it was sent with').toBe(smallSha256);

    expect(
      session.consoleClean.failures,
      'CONSOLE CLEAN violated during the Saved Messages transfer: every entry is an error the user\'s console showed'
    ).toEqual([]);
  } finally {
    await session.close();
  }
});
