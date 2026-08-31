/*
 * Structured logging transport for ImpulseM: classifies every diagnostic by
 * level, redacts personal data, and ships batches to Loki.
 *
 * Two entry points feed it:
 *   1. getLogger(module)  — structured call sites, full (message, payload, error)
 *   2. the logsBuffer sink — every existing logger(prefix) call in the app, so
 *      the port needed no rewrite of call sites. The prefix becomes the `module`
 *      label, which is the axis most Loki queries slice on.
 *
 * Ported from ImpulseM.Client.Web.A (src/util/logger.ts) with four fixes:
 *   - no DEBUG gate: production builds ship too (A shipped nothing in prod)
 *   - failed batches are requeued instead of dropped
 *   - the buffer is flushed on pagehide via sendBeacon, so the last diagnostics
 *     before a tab closes are not lost
 *   - the buffer is bounded, so a dead gateway cannot grow it without limit
 */

import {IS_SERVICE_WORKER, IS_WEB_WORKER} from '@helpers/context';
import {setLogSink} from '@lib/debug/logsBuffer';
import {backendHttpOrigin} from '@config/backendOrigin';

const FLUSH_BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_BUFFER_ENTRIES = 1_000;
// The Fetch standard caps total in-flight keepalive request bodies at 64 KiB.
const KEEPALIVE_BODY_BUDGET_BYTES = 65_536;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const MAX_ERROR_NAME_LENGTH = 128;
const MAX_ERROR_STACK_LENGTH = 32_768;
const LOKI_PUSH_URL = `${backendHttpOrigin()}/loki/api/v1/push`;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'text', 'message', 'caption', 'body', 'content', 'bytes',
  'firstname', 'lastname', 'username', 'phone', 'phonenumber', 'email',
  'filename', 'password', 'passcode', 'authkey', 'sessionkey',
  'phonecode', 'smscode', 'emailcode', 'recoverycode'
  // NOT 'code': the sensitive ones are named above, while a bare `code` is an
  // HTTP status or an error code. Redacting it turned every failure in Loki into
  // `{"type":"AUTH_KEY_UNREGISTERED","code":"[REDACTED]"}` -- the one field that
  // says how bad it was.
]);
const BEARER_PATTERN = /Bearer\s+\S+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PHONE_PATTERN = /\+?\d[\d\s()-]{7,}\d/g;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogPayload = Record<string, unknown>;

type SerializedError = {
  name: string,
  message: string,
  stack?: string,
  cause?: unknown
};

type LogRecord = {
  timestamp: string,
  level: LogLevel,
  module: string,
  message: string,
  payload?: unknown,
  error?: SerializedError
};

type LokiEntry = {
  level: LogLevel,
  timestampNanos: string,
  line: string
};

export type Logger = {
  debug(message: string, payload?: LogPayload, error?: unknown): void,
  info(message: string, payload?: LogPayload): void,
  warn(message: string, payload?: LogPayload, error?: unknown): void,
  error(message: string, payload?: LogPayload, error?: unknown): void
};

const SERIALIZATION_FAILURE: SerializedError = {
  name: 'SerializationError',
  message: 'The thrown value could not be serialized'
};
const MISSING_REJECTION_REASON: SerializedError = {
  name: 'UnknownError',
  message: 'No rejection reason was provided'
};

const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

const component: string = IS_SERVICE_WORKER ? 'service-worker' : (IS_WEB_WORKER ? 'worker' : 'main');
const loggers = new Map<string, Logger>();

let buffer: LokiEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let isFlushing = false;
let isRetrying = false;
let droppedEntries = 0;

export function getLogger(module: string): Logger {
  let logger = loggers.get(module);
  if(logger) {
    return logger;
  }

  logger = {
    debug: (message, payload, error) => emit('debug', module, message, payload, error),
    info: (message, payload) => emit('info', module, message, payload, undefined),
    warn: (message, payload, error) => emit('warn', module, message, payload, error),
    error: (message, payload, error) => emit('error', module, message, payload, error)
  };
  loggers.set(module, logger);
  return logger;
}

/**
 * Sink for the app's existing logger(prefix) calls — see lib/debug/logsBuffer.
 * `level` is a LogTypes bitmask literal (Error=1, Warn=2, Log=4, Debug=8).
 */
export function captureAppLog(level: number, prefix: string, args: unknown[]): void {
  const [firstArg, ...rest] = args;
  const message = describeValue(firstArg);
  const payload = rest.length ? {values: rest.map((value) => safelySanitizeValue(value))} : undefined;
  const logLevel = toLogLevel(level);

  // The app's legacy logger is variadic and puts the human-readable text first, so the thrown
  // value usually sits somewhere in `rest` -- serializing only `firstArg` reduced every such
  // record in Loki to a bare headline with no type, no message and no stack, which is how a
  // client-side TypeError could be visible in the browser console yet invisible in telemetry.
  // Take the first Error found anywhere in the arguments, and fall back to the old behaviour.
  const thrown = args.find((value) => value instanceof Error) ?? firstArg;

  emitRecord({
    timestamp: new Date().toISOString(),
    level: logLevel,
    module: normalizeModule(prefix),
    message,
    payload,
    error: logLevel === 'error' ? safelySerializeError(thrown) : undefined
  });
}

function toLogLevel(level: number): LogLevel {
  if(level & 1) return 'error';
  if(level & 2) return 'warn';
  if(level & 8) return 'debug';
  return 'info';
}

// Prefixes arrive as "[appMessagesManager]" and may carry ANSI colour codes
// from bound loggers; both are noise in a Loki label.
function normalizeModule(prefix: string): string {
  if(!prefix) {
    return 'app';
  }

  // Bound loggers nest their prefixes -- '[ACC-1-UPDATES] [processUpdate]' -- and
  // stripping only the outermost brackets left 'ACC-1-UPDATES] [processUpdate',
  // which is neither readable nor groupable. Join the segments instead.
  // eslint-disable-next-line no-control-regex
  return prefix.replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/\]\s*\[/g, '/')
  .replace(/[[\]]/g, '')
  .trim() || 'app';
}

function emit(level: LogLevel, module: string, message: string, payload: unknown, error: unknown): void {
  try {
    emitRecord({
      timestamp: new Date().toISOString(),
      level,
      module,
      message: safelyStringify(message),
      payload: payload === undefined ? undefined : safelySanitizeValue(payload),
      error: error === undefined ? undefined : safelySerializeError(error)
    });
  } catch{
    originalConsole.warn('[logging] Failed to capture structured diagnostic');
  }
}

function emitRecord(record: LogRecord): void {
  try {
    const line = JSON.stringify(record);
    if(buffer.length >= MAX_BUFFER_ENTRIES) {
      buffer.shift();
      ++droppedEntries;
    }

    buffer.push({
      level: record.level,
      timestampNanos: String(Date.now() * 1_000_000),
      line
    });
  } catch{
    originalConsole.warn('[logging] Failed to serialize log record');
    return;
  }

  scheduleFlush(buffer.length >= FLUSH_BATCH_SIZE);
}

function scheduleFlush(isImmediate: boolean): void {
  if(flushTimer !== undefined) {
    clearTimeout(flushTimer);
  }

  flushTimer = setTimeout(flush, isImmediate ? 0 : FLUSH_INTERVAL_MS);
}

function buildPayload(entries: LokiEntry[]): string {
  const byLevel = new Map<LogLevel, [string, string][]>();
  entries.forEach((entry) => {
    const values = byLevel.get(entry.level) ?? [];
    values.push([entry.timestampNanos, entry.line]);
    byLevel.set(entry.level, values);
  });

  const streams = Array.from(byLevel.entries()).map(([level, values]) => ({
    stream: {service_name: 'ImpulseM.Client', component, level},
    values
  }));

  return JSON.stringify({streams});
}

function getPayloadByteLength(entries: LokiEntry[]): number {
  return new TextEncoder().encode(buildPayload(entries)).byteLength;
}

function boundBufferToKeepaliveBudget(): void {
  while(buffer.length && getPayloadByteLength(buffer) > KEEPALIVE_BODY_BUDGET_BYTES) {
    buffer.shift();
    ++droppedEntries;
  }
}

function flush(): void {
  flushTimer = undefined;
  if(isFlushing || !buffer.length) {
    return;
  }

  if(isRetrying) {
    boundBufferToKeepaliveBudget();
  }

  if(droppedEntries) {
    originalConsole.warn(`[logging] Dropped ${droppedEntries} buffered entries (buffer full)`);
    droppedEntries = 0;
  }

  const batch = buffer;
  buffer = [];
  isFlushing = true;

  fetch(LOKI_PUSH_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: buildPayload(batch),
    credentials: 'omit'
  }).then((response) => {
    if(!response.ok) {
      throw new Error(`Loki responded ${response.status}`);
    }
    isRetrying = false;
  }).catch((err: unknown) => {
    // Requeue instead of dropping: a transient gateway blip must not silently
    // erase the diagnostics that explain it. Oldest-first, bounded.
    buffer = batch.concat(buffer).slice(-MAX_BUFFER_ENTRIES);
    isRetrying = true;
    boundBufferToKeepaliveBudget();
    originalConsole.warn('[logging] Loki transport failed', safelySerializeError(err));
  }).finally(() => {
    isFlushing = false;
    if(buffer.length) {
      scheduleFlush(false);
    }
  });
}

/**
 * Last-gasp flush. `sendBeacon` would be the obvious choice, but it always sends
 * the request WITH credentials, and the Loki endpoint does not answer with
 * `Access-Control-Allow-Credentials: true` -- so the final batch was dropped and
 * the failure surfaced as a CORS error in the user's console. `fetch` with
 * `keepalive` outlives the unload the same way a beacon does while keeping the
 * request credential-free, like the normal flush above.
 */
function flushOnHide(): void {
  if(!buffer.length) {
    return;
  }

  let firstEntryIndex = buffer.length - 1;
  while(firstEntryIndex >= 0 &&
    getPayloadByteLength(buffer.slice(firstEntryIndex)) <= KEEPALIVE_BODY_BUDGET_BYTES) {
    --firstEntryIndex;
  }

  const batch = buffer.slice(firstEntryIndex + 1);
  if(!batch.length) {
    return;
  }

  buffer = buffer.slice(0, firstEntryIndex + 1);
  try {
    fetch(LOKI_PUSH_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: buildPayload(batch),
      keepalive: true,
      credentials: 'omit'
    }).catch(() => {});
  } catch{
    buffer = batch.concat(buffer).slice(-MAX_BUFFER_ENTRIES);
  }
}

function reportUnhandledRejection(event: PromiseRejectionEvent, logger: Logger): void {
  const reason = event.reason === undefined ? MISSING_REJECTION_REASON : event.reason;
  logger.error('unhandled rejection', undefined, reason);
}

if(typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden') {
      flushOnHide();
    }
  });
}

if(typeof self !== 'undefined' && typeof addEventListener === 'function') {
  addEventListener('pagehide', flushOnHide);

  // Capture uncaught errors and unhandled promise rejections into the same Loki sink. Without
  // this, client-side crashes (a null-deref opening a menu, a viewer that throws on open) are
  // invisible to telemetry and can only be found by reproducing them in front of a devtools
  // console -- which is exactly why several client bugs could not be traced. Runs in the main
  // thread, web worker and service worker alike (every context imports this module).
  const uncaughtLogger = getLogger('uncaught');
  addEventListener('error', (event) => {
    const errorEvent = event as ErrorEvent;
    // Only script errors: resource-load failures surface as a bare Event (no message/error) and
    // reach a non-capturing window listener only when they bubble, which they do not.
    if(errorEvent.error === undefined && !errorEvent.message) {
      return;
    }
    uncaughtLogger.error('uncaught error', undefined, errorEvent.error ?? errorEvent);
  });
  addEventListener('unhandledrejection', (event) => {
    reportUnhandledRejection(event as PromiseRejectionEvent, uncaughtLogger);
  });
}

function sanitizeValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  // Redaction keys off the field NAME, so anything merely named like a secret was
  // blanked whatever it held -- `hasSessionToken: true` came back '[REDACTED]',
  // which is how a diagnostic added to answer a question ended up answering
  // nothing. A boolean cannot carry a credential; let it through.
  if(key && typeof value !== 'boolean' && isSensitiveKey(key)) {
    return REDACTED;
  }

  if(value instanceof Error) {
    return serializeError(value);
  }

  // A DOM event keeps everything on its prototype as accessors, so Object.keys
  // below sees only `isTrusted`. That is why every worker crash and socket drop
  // reached the logs as `{isTrusted: true}` and identified nothing.
  if(typeof Event !== 'undefined' && value instanceof Event) {
    return serializeEvent(value, seen);
  }

  if(typeof value === 'bigint') {
    return value.toString();
  }

  if(typeof value === 'string') {
    return sanitizeString(value);
  }

  if(!value || typeof value !== 'object') {
    return value;
  }

  if(seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  if(Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, undefined, seen));
  }

  try {
    return Object.fromEntries(Object.keys(value).map((entryKey) => {
      try {
        return [entryKey, sanitizeValue(Reflect.get(value, entryKey), entryKey, seen)];
      } catch{
        return [entryKey, '[Unserializable: getter threw]'];
      }
    }));
  } catch{
    return '[Unserializable object]';
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || normalized.endsWith('token');
}

function serializeError(error: unknown, seen = new WeakSet<object>()): SerializedError {
  if(!isErrorLike(error)) {
    return {
      name: 'UnknownError',
      message: serializeThrownValue(error)
    };
  }

  if(seen.has(error)) {
    return {
      name: getErrorString(error, 'name', 'Error', MAX_ERROR_NAME_LENGTH),
      message: '[Circular error cause]'
    };
  }

  seen.add(error);
  const cause = getErrorProperty(error, 'cause');
  return {
    name: getErrorString(error, 'name', 'Error', MAX_ERROR_NAME_LENGTH),
    message: getErrorString(error, 'message', 'No error message', MAX_ERROR_MESSAGE_LENGTH),
    stack: getOptionalErrorString(error, 'stack', MAX_ERROR_STACK_LENGTH),
    cause: cause === undefined ? undefined : serializeError(cause, seen)
  };
}

function isErrorLike(value: unknown): value is object {
  if(!value || typeof value !== 'object') {
    return false;
  }

  return value instanceof Error || (
    typeof getErrorProperty(value, 'name') === 'string' &&
    typeof getErrorProperty(value, 'message') === 'string'
  );
}

function getErrorProperty(error: object, key: string): unknown {
  try {
    return Reflect.get(error, key);
  } catch{
    return undefined;
  }
}

function getErrorString(error: object, key: string, fallback: string, maxLength: number): string {
  const value = getErrorProperty(error, key);
  return typeof value === 'string' && value ? truncateString(sanitizeString(value), maxLength) : fallback;
}

function getOptionalErrorString(error: object, key: string, maxLength: number): string | undefined {
  const value = getErrorProperty(error, key);
  return typeof value === 'string' && value ? truncateString(sanitizeString(value), maxLength) : undefined;
}

function serializeThrownValue(value: unknown): string {
  if(value === undefined) {
    return 'undefined';
  }

  const sanitized = safelySanitizeValue(value);
  if(typeof sanitized === 'string') {
    return truncateString(sanitized, MAX_ERROR_MESSAGE_LENGTH);
  }

  try {
    return truncateString(JSON.stringify(sanitized) ?? safelyStringify(sanitized), MAX_ERROR_MESSAGE_LENGTH);
  } catch{
    return truncateString(safelyStringify(sanitized), MAX_ERROR_MESSAGE_LENGTH);
  }
}

/** Pull the fields that actually identify a failure out of a DOM event. */
function serializeEvent(event: Event, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {eventType: event.type};

  const asError = event as Partial<ErrorEvent>;
  if(typeof asError.message === 'string' && asError.message) {
    out.message = sanitizeString(asError.message);
  }

  if(typeof asError.filename === 'string' && asError.filename) {
    out.filename = sanitizeString(asError.filename);
    out.lineno = asError.lineno;
    out.colno = asError.colno;
  }

  if(asError.error !== undefined && asError.error !== null) {
    out.error = sanitizeValue(asError.error, undefined, seen);
  }

  const asClose = event as Partial<CloseEvent>;
  if(typeof asClose.code === 'number') {
    out.closeCode = asClose.code;
    out.closeReason = asClose.reason ? sanitizeString(asClose.reason) : '';
    out.wasClean = asClose.wasClean;
  }

  const asRejection = event as unknown as {reason?: unknown};
  if(event.type === 'unhandledrejection' && asRejection.reason !== undefined) {
    out.reason = sanitizeValue(asRejection.reason, undefined, seen);
  }

  return out;
}


function safelySanitizeValue(value: unknown): unknown {
  try {
    return sanitizeValue(value);
  } catch{
    return '[Unserializable value]';
  }
}

function safelySerializeError(error: unknown): SerializedError {
  try {
    return serializeError(error);
  } catch{
    return SERIALIZATION_FAILURE;
  }
}

function safelyStringify(value: unknown): string {
  try {
    return sanitizeString(String(value));
  } catch{
    return '[Unserializable value]';
  }
}

/**
 * Render whatever was logged as the leading argument. `String(value)` collapses
 * every object to '[object Object]' -- which is exactly how a diagnostic like
 * `log.error(apiError)` reached Loki carrying no information at all. Objects are
 * serialised (and sanitised) instead; primitives keep their plain form.
 */
function describeValue(value: unknown): string {
  if(typeof value === 'string') {
    return sanitizeString(value);
  }

  if(value === null || value === undefined || typeof value !== 'object') {
    return safelyStringify(value);
  }

  const sanitized = safelySanitizeValue(value);
  if(typeof sanitized === 'string') {
    return truncateString(sanitized, MAX_ERROR_MESSAGE_LENGTH);
  }

  try {
    return truncateString(JSON.stringify(sanitized) ?? safelyStringify(sanitized), MAX_ERROR_MESSAGE_LENGTH);
  } catch{
    return truncateString(safelyStringify(sanitized), MAX_ERROR_MESSAGE_LENGTH);
  }
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
}

function sanitizeString(value: string): string {
  return value
  .replace(BEARER_PATTERN, REDACTED)
  .replace(JWT_PATTERN, REDACTED)
  .replace(PHONE_PATTERN, REDACTED);
}

export const testLoggerSanitizers = {
  sanitizeValue,
  serializeError,
  reportUnhandledRejection
};

// Registering here (rather than logsBuffer importing us) keeps logsBuffer a
// leaf module on the hot logging path. Importing this file for side effects
// from an entry point is enough to arm telemetry for that context.
setLogSink(captureAppLog);
