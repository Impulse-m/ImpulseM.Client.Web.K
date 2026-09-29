import {createHash} from 'crypto';
import {readFile, unlink} from 'fs/promises';

import type {Page} from '@playwright/test';

import {attachAsFileThroughUi, documentRow, receivedDocumentRow, waitForDocumentRow} from './documentRow';
import {liveLane} from './lane';
import {deterministicArchive} from './mediaFixtures';
import {expect, test} from './pair';

/*
 * Archive120 (#675 follow-up) — the real-browser closing test for the reported 120 MiB document
 * upload incident. Everything before this file was read-only diagnosis (see the archive120-*
 * runs in .local/share/impulsem-cao/runs/): a stalled upload.saveBigFilePart body, canceled at
 * ~100s in the measured trace, over the ACTUAL public ingress (Firefox, nginx grpc_pass ->
 * Gateway:5200, no confirmed quota/OOM signal). None of that is asserted here — this scenario
 * exists to OBSERVE a genuine red (or a genuine green) against unchanged production, not to
 * reproduce a specific diagnosed mechanism.
 *
 * "100% progress" is explicitly NOT the oracle (appMessagesManager.ts:2609's percent readout is
 * fed purely by upload.saveBigFilePart acks, apiFileManager.ts:1206-1207 — it says nothing about
 * messages.sendMedia, which the client calls only after the upload promise resolves, or about the
 * server-side finalization that call blocks on). The oracle here is the full round trip: the
 * sender's own bubble settling, the recipient actually receiving and rendering the document, and
 * a REAL browser download of that document producing bytes identical to what was attached.
 *
 * Reuse, not a parallel harness:
 *   - ./pair for two ephemeral, independently authenticated sessions with the dialog already
 *     open on both sides (existing sender/recipient fixture, unconditional cleanup).
 *   - ./documentRow's attachAsFileThroughUi / receivedDocumentRow / documentRow / waitForDocumentRow
 *     — the exact "Document" attach-menu surface and row locators #118/#119 already built and
 *     proved out (videoSentAsFile.live.spec.ts). Only settleTimeoutMs was added to
 *     attachAsFileThroughUi (default unchanged) so a 120 MiB send is not held to the same 120s
 *     budget a text/small-file send needs.
 *   - ./mediaFixtures's new deterministicArchive(name, sizeBytes): a Buffer.copy-tiled, per-call
 *     UNIQUE (so server-side hash dedup cannot let a rerun skip the real transfer) synthetic
 *     payload. Not a real ZIP: nothing on either side of this pipeline parses archive contents
 *     for a plain document attachment (confirmed in the read-only pass — the finalizer's document
 *     branch is byte-agnostic), so a fabricated central directory would add complexity with no
 *     test value. What is under test is the byte pipeline itself.
 *
 * Firefox / public ingress: this file is the ONLY spec matched by the `firefox-archive120`
 * project (playwright.live.config.ts) and is additionally gated on its own env var so the
 * existing chromium live suite is provably unaffected and so a bare `pnpm run test:e2e:live`
 * cannot accidentally fire 120 MiB at production. See the freeze report for the exact invocation.
 */
const archive120Enabled = process.env.IMPULSE_LIVE_ARCHIVE120 === '1';
test.skip(!liveLane.enabled, liveLane.skipReason);
test.skip(
  !archive120Enabled,
  'IMPULSE_LIVE_ARCHIVE120 is not set — this scenario sends an approximately 120 MiB document ' +
  'over a real network and is never run as part of the ordinary live suite. Set ' +
  'IMPULSE_LIVE_ARCHIVE120=1 (together with IMPULSE_LIVE_WS_GATEWAY pointed at the origin under ' +
  'test) and target the dedicated project: ' +
  'pnpm exec playwright test --config=playwright.live.config.ts --project=firefox-archive120'
);

const archiveSizeBytes = 120 * 1024 * 1024; // matches the incident's own reported scale exactly:
// 125829120 / 65536 (apiFileManager.ts's current part size for a file this size, getLimitPart)
// = 1920 whole parts, the same part-count order of magnitude the live evidence was measured at.

const sendCompletionTimeoutMs = 600_000; // upload (all saveBigFilePart parts) + messages.sendMedia
// + server-side finalization (sequential part reread, SHA-256, S3 multipart complete) — traced in
// the read-only pass as one synchronous chain the client blocks on after "100%".
const recipientRowTimeoutMs = receivedDocumentRow.quietTimeoutMs; // 90s, existing lane default —
// message delivery, not file bytes; unchanged.
const downloadEventTimeoutMs = 60_000; // time to the download STARTING (headers), not finishing.
const downloadCompletionTimeoutMs = 300_000; // time for the full 120 MiB to actually land on disk.

test.describe.configure({
  timeout: sendCompletionTimeoutMs + recipientRowTimeoutMs + downloadEventTimeoutMs + downloadCompletionTimeoutMs + 120_000
});


/**
 * Minimal, test-local network diagnostics — Playwright's own request/response objects, never
 * production telemetry. Bounded and content-free per the task's own constraint: RPC method
 * (path only), status, failed/canceled, and counts/durations for the high-volume upload-part
 * calls rather than one line per part (there are ~1920 of them for this fixture size). No bodies,
 * no headers, no tokens.
 */
function wireRpcSummary(page: Page) {
  const partCalls = {count: 0, failed: 0};
  const notable: string[] = [];
  const notableCap = 40;

  const isUploadPart = (path: string) => path.endsWith('/SaveBigFilePart') || path.endsWith('/SaveFilePart');

  page.on('requestfinished', async(request) => {
    const url = new URL(request.url());
    if(!url.pathname.startsWith('/v1.')) return;
    if(isUploadPart(url.pathname)) {
      partCalls.count++;
      return;
    }
    const response = await request.response().catch((): null => null);
    if(notable.length < notableCap) {
      notable.push(`${url.pathname} -> ${response ? response.status() : '(no response)'}`);
    }
  });

  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if(!url.pathname.startsWith('/v1.')) return;
    if(isUploadPart(url.pathname)) {
      partCalls.count++;
      partCalls.failed++;
      return;
    }
    if(notable.length < notableCap) {
      notable.push(`${url.pathname} -> FAILED: ${request.failure()?.errorText ?? '(unknown)'}`);
    }
  });

  return {
    describe(): string {
      return `upload-part RPCs observed: ${partCalls.count} (failed/canceled: ${partCalls.failed})\n` +
        `other RPCs observed (method -> outcome, capped at ${notableCap}):\n` +
        (notable.length ? notable.map((line) => `  ${line}`).join('\n') : '  (none)');
    }
  };
}


test(
  '#675 archive120: a ~120 MiB document survives real upload, delivery, and download byte-identical',
  async({pair}) => {
    const {sender, recipient} = pair;
    const nonce = Date.now().toString(36);
    const fixture = deterministicArchive(`archive120-${nonce}.zip`, archiveSizeBytes);
    const fixtureHash = createHash('sha256').update(fixture.buffer).digest('hex');

    const senderRpc = wireRpcSummary(sender.page);
    const recipientRpc = wireRpcSummary(recipient.page);

    const withStage = async<T>(stage: string, action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch(error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[stage: ${stage}] ${detail}\n` +
          `sender RPCs:\n${senderRpc.describe()}\n` +
          `recipient RPCs:\n${recipientRpc.describe()}`
        );
      }
    };

    await withStage('attach + upload + send', () =>
      attachAsFileThroughUi(sender, [fixture], sendCompletionTimeoutMs));

    await withStage('recipient receives and renders the document', () =>
      waitForDocumentRow(recipient, receivedDocumentRow));

    const row = documentRow(recipient.page, receivedDocumentRow);

    const download = await withStage('recipient download starts', async() => {
      const [downloadEvent] = await Promise.all([
        recipient.page.waitForEvent('download', {timeout: downloadEventTimeoutMs}),
        row.click()
      ]);
      return downloadEvent;
    });

    const downloadedPath = await withStage('recipient download completes', async() => {
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(
          `the browser download of the ~${archiveSizeBytes}-byte fixture did not finish within ` +
          `${downloadCompletionTimeoutMs}ms`
        )), downloadCompletionTimeoutMs);
      });

      let path: string | null;
      try {
        path = await Promise.race([download.path(), timedOut]);
      } finally {
        clearTimeout(timeoutHandle!);
      }

      if(!path) {
        const failure = await download.failure();
        throw new Error(`the browser reported no local file for the download (failure: ${failure ?? '(none reported)'})`);
      }
      return path;
    });

    try {
      await withStage('downloaded byte identity', async() => {
        const downloadedBytes = await readFile(downloadedPath);
        expect(
          downloadedBytes.length,
          `downloaded byte length (${downloadedBytes.length}) does not match the attached fixture ` +
          `(${fixture.buffer.length}) — a truncated or padded transfer is exactly the "stalled mid-way" ` +
          'shape this scenario exists to catch'
        ).toBe(fixture.buffer.length);

        const downloadedHash = createHash('sha256').update(downloadedBytes).digest('hex');
        expect(
          downloadedHash,
          `downloaded SHA-256 (${downloadedHash}) does not match the attached fixture's own hash ` +
          `(${fixtureHash}) — the recipient's copy is not byte-identical to what the sender sent`
        ).toBe(fixtureHash);
      });
    } finally {
      await unlink(downloadedPath).catch(() => {});
    }
  }
);
