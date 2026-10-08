import EventListenerBase from '@helpers/eventListenerBase';
import type {
  LiveKitMediaSource,
  LiveKitTransportEvents,
  LiveKitTransportState
} from '@lib/calls/livekit/liveKitTransport';
import type {PhoneCallTransport} from '@lib/calls/livekit/phoneCallSession';

// A scriptable transport for PhoneCallSession / CallInstance tests: records every media call, lets a test
// hold a call open (`hold`), make it fail (`failNext`), and push transport events.
export default class FakePhoneCallTransport extends EventListenerBase<LiveKitTransportEvents> implements PhoneCallTransport {
  public static instances: FakePhoneCallTransport[] = [];

  public state: LiveKitTransportState = 'idle';
  public localIdentity: string | undefined;
  public published = new Map<LiveKitMediaSource, MediaStreamTrack>();
  public muted = new Map<LiveKitMediaSource, boolean>();
  public calls: string[] = [];
  public connectArgs: unknown[] | undefined;
  public disconnectCount = 0;
  private holds = new Map<string, Promise<void>>();
  private failures = new Map<string, Error>();

  constructor() {
    super(false);
    FakePhoneCallTransport.instances.push(this);
  }

  /** The next `method` call waits for `promise` before it takes effect. */
  public hold(method: 'connect' | 'publish' | 'replace' | 'setMuted' | 'unpublish', promise: Promise<void>): void {
    this.holds.set(method, promise);
  }

  /** The next `method` call rejects with `error`. */
  public failNext(method: 'connect' | 'publish' | 'replace' | 'setMuted' | 'unpublish', error: Error): void {
    this.failures.set(method, error);
  }

  /** Puts the transport in `state` the way LiveKit does, announcing it. */
  public emitState(state: LiveKitTransportState, cause?: Parameters<LiveKitTransportEvents['state']>[1]): void {
    this.state = state;
    this.dispatchEvent('state', state, cause);
  }

  public async connect(params: unknown, options: unknown): Promise<void> {
    this.connectArgs = [params, options];
    this.calls.push('connect');
    this.emitState('connecting');
    await this.settle('connect');
    this.emitState('connected');
  }

  public async publish(options: {source: LiveKitMediaSource, track: MediaStreamTrack}): Promise<void> {
    this.calls.push(`publish:${options.source}`);
    await this.settle('publish');
    this.published.set(options.source, options.track);
    this.muted.set(options.source, false);
  }

  public async replace(options: {source: LiveKitMediaSource, track: MediaStreamTrack}): Promise<void> {
    this.calls.push(`replace:${options.source}`);
    await this.settle('replace');
    this.published.set(options.source, options.track);
  }

  public async setMuted(options: {source: LiveKitMediaSource, muted: boolean}): Promise<void> {
    this.calls.push(`setMuted:${options.source}:${options.muted}`);
    await this.settle('setMuted');
    this.muted.set(options.source, options.muted);
  }

  public async unpublish(source: LiveKitMediaSource): Promise<void> {
    this.calls.push(`unpublish:${source}`);
    await this.settle('unpublish');
    this.published.delete(source);
    this.muted.delete(source);
  }

  public isPublished(source: LiveKitMediaSource): boolean {
    return this.published.has(source);
  }

  public getPublishedTrack(source: LiveKitMediaSource): MediaStreamTrack | undefined {
    return this.published.get(source);
  }

  public getPublishPermission(): undefined {
    return undefined;
  }

  /** Like LiveKitTransport.disconnect: nothing counts as published any more. */
  public disconnect(): void {
    ++this.disconnectCount;
    this.calls.push('disconnect');
    this.published.clear();
    this.muted.clear();
  }

  public async getDiagnostics(): Promise<never> {
    throw new Error('not used in this fake');
  }

  private async settle(method: string): Promise<void> {
    const failure: Error | undefined = this.failures.get(method);
    if(failure) {
      this.failures.delete(method);
      throw failure;
    }

    const hold: Promise<void> | undefined = this.holds.get(method);
    if(hold) {
      this.holds.delete(method);
      await hold;
    }
  }
}
