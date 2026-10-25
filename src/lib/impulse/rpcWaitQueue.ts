import {errorCodes} from '@impulsem/centrifuge/build/protobuf';
import type {Error as CentrifugeError} from '@impulsem/centrifuge/build/protobuf';

import {isFleetRpcError} from './fleet/fleetError';

/*
 * A call refused at maxPendingRpc was not sent (SDK README.md:340): it waits here, in refusal order, and is sent when
 * a tracked call of the client settles. The settle releases it; no timer does.
 */

type SendAttempt<T> = (timeoutMs: number | undefined) => Promise<T>;

type Waiter<T> = {
  send: SendAttempt<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  timer: ReturnType<typeof setTimeout> | undefined,
  onAbort: (() => void) | undefined,
  resolve: (value: T) => void,
  reject: (reason: unknown) => void
};

export class RpcWaitQueue<T> {
  private readonly waiters: Waiter<T>[] = [];
  private readonly callTimeoutMs: number;
  private readonly maxWaiters: number;

  public constructor(callTimeoutMs: number, maxWaiters: number) {
    this.callTimeoutMs = callTimeoutMs;
    this.maxWaiters = maxWaiters;
  }

  /** Sends the call now, unless calls wait ahead of it; a call refused at the bound waits for a settled call. */
  public run(send: SendAttempt<T>, signal: AbortSignal | undefined): Promise<T> {
    if(this.waiters.length > 0) {
      return this.wait(send, signal);
    }

    return this.attempt(send, undefined).catch((error: unknown): Promise<T> => {
      if(!isLimitExceeded(error)) {
        throw error;
      }

      return this.wait(send, signal);
    });
  }

  private wait(send: SendAttempt<T>, signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
      if(this.waiters.length >= this.maxWaiters) {
        reject(limitExceededError());
        return;
      }

      this.enqueue({
        send,
        signal,
        deadlineAt: Date.now() + this.callTimeoutMs,
        timer: undefined,
        onAbort: undefined,
        resolve,
        reject
      }, false);
    });
  }

  private enqueue(waiter: Waiter<T>, atHead: boolean): void {
    if(waiter.signal?.aborted) {
      waiter.reject(cancelledError());
      return;
    }

    if(atHead) {
      this.waiters.unshift(waiter);
    } else {
      this.waiters.push(waiter);
    }
    this.arm(waiter);
  }

  private attempt(send: SendAttempt<T>, timeoutMs: number | undefined): Promise<T> {
    return send(timeoutMs).then(
      (value: T): T => {
        this.release();
        return value;
      },
      (error: unknown): never => {
        if(!isLimitExceeded(error)) {
          this.release();
        }
        throw error;
      }
    );
  }

  private release(): void {
    let waiter: Waiter<T> | undefined = this.waiters.shift();
    while(waiter) {
      this.disarm(waiter);
      const remainingMs: number = waiter.deadlineAt - Date.now();
      if(remainingMs > 0) {
        this.dispatch(waiter, remainingMs);
        return;
      }

      waiter.reject(timeoutError());
      waiter = this.waiters.shift();
    }
  }

  private dispatch(waiter: Waiter<T>, remainingMs: number): void {
    this.attempt(waiter.send, remainingMs).then(waiter.resolve, (error: unknown): void => {
      if(!isLimitExceeded(error)) {
        waiter.reject(error);
        return;
      }

      this.enqueue(waiter, true);
    });
  }

  private arm(waiter: Waiter<T>): void {
    waiter.timer = setTimeout((): void => this.expire(waiter), Math.max(0, waiter.deadlineAt - Date.now()));
    waiter.onAbort = (): void => this.cancel(waiter);
    waiter.signal?.addEventListener('abort', waiter.onAbort, {once: true});
  }

  private disarm(waiter: Waiter<T>): void {
    clearTimeout(waiter.timer);
    if(waiter.onAbort) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
    }

    waiter.timer = undefined;
    waiter.onAbort = undefined;
  }

  private expire(waiter: Waiter<T>): void {
    this.remove(waiter);
    this.disarm(waiter);
    waiter.reject(timeoutError());
  }

  private cancel(waiter: Waiter<T>): void {
    this.remove(waiter);
    this.disarm(waiter);
    waiter.reject(cancelledError());
  }

  private remove(waiter: Waiter<T>): void {
    const index: number = this.waiters.indexOf(waiter);
    if(index >= 0) {
      this.waiters.splice(index, 1);
    }
  }
}

function isLimitExceeded(error: unknown): boolean {
  return isFleetRpcError(error) && error.code === errorCodes.limitExceeded;
}

// The codes the SDK rejects a timed-out or aborted call with, so the caller sees the same rejections.
function limitExceededError(): CentrifugeError {
  return {code: errorCodes.limitExceeded, message: 'too many pending rpc calls'};
}

function timeoutError(): CentrifugeError {
  return {code: errorCodes.timeout, message: 'timeout'};
}

function cancelledError(): CentrifugeError {
  return {code: errorCodes.cancelled, message: 'cancelled'};
}
