import {describe, expect, it, vi} from 'vitest';

import {Logger, testLoggerSanitizers} from '@lib/impulseLogger';

function reportReason(reason: unknown): unknown {
  const error = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error
  };
  const event = new Event('unhandledrejection') as PromiseRejectionEvent;
  Object.defineProperty(event, 'reason', {value: reason});

  testLoggerSanitizers.reportUnhandledRejection(event, logger);

  expect(error).toHaveBeenCalledOnce();
  return error.mock.calls[0][2];
}

describe('uncaught rejection reporting', () => {
  it('reports an Error reason with its stack and cause chain', () => {
    const cause = new TypeError('upload URL contained Bearer secret-token');
    // The two-argument Error constructor is ES2022; this project's lib target does not
    // declare it, so attach the cause explicitly rather than widening the target for a test.
    const reason = new Error('music upload failed');
    (reason as Error & {cause?: unknown}).cause = cause;
    reason.stack = 'Error: music upload failed\n    at sendMusic (send.ts:42:1)';

    expect(testLoggerSanitizers.serializeError(reportReason(reason))).toEqual({
      name: 'Error',
      message: 'music upload failed',
      stack: 'Error: music upload failed\n    at sendMusic (send.ts:42:1)',
      cause: {
        name: 'TypeError',
        message: 'upload URL contained [REDACTED]',
        stack: expect.any(String),
        cause: undefined
      }
    });
  });

  it('reports a DOMException reason by its real name, message and stack', () => {
    const serialized = testLoggerSanitizers.serializeError(
      reportReason(new DOMException('The operation was aborted', 'AbortError'))
    );

    expect(serialized).toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted',
      stack: expect.any(String)
    });
  });

  it('reports a plain object reason without leaking sensitive fields', () => {
    expect(testLoggerSanitizers.serializeError(reportReason({
      type: 'UPLOAD_FAILED',
      filename: 'board-recording.mp3',
      url: 'https://upload.invalid/?authorization=Bearer upload-token'
    }))).toEqual({
      name: 'UnknownError',
      message: '{"type":"UPLOAD_FAILED","filename":"[REDACTED]","url":"https://upload.invalid/?authorization=[REDACTED]"}'
    });
  });

  it('reports a string reason verbatim', () => {
    expect(testLoggerSanitizers.serializeError(reportReason('upload rejected'))).toEqual({
      name: 'UnknownError',
      message: 'upload rejected'
    });
  });

  it('explicitly reports an undefined reason as carrying no information', () => {
    expect(testLoggerSanitizers.serializeError(reportReason(undefined))).toEqual({
      name: 'UnknownError',
      message: 'No rejection reason was provided'
    });
  });
});
