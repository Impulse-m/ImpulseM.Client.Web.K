export type LiveKitDisconnectCause = 'client' | 'roomDeleted' | 'removed' | 'duplicateIdentity' | 'rejected' | 'network' | 'unknown';

export type LiveKitMediaSource = 'microphone' | 'camera' | 'screen' | 'screenAudio';


/** The token (or a later permission update) does not let this participant publish the source. */
export class LiveKitPublishDeniedError extends Error {
  public readonly source: LiveKitMediaSource;

  constructor(source: LiveKitMediaSource) {
    super(`LIVEKIT_PUBLISH_DENIED: publishing ${source} is not permitted`);
    this.name = 'LiveKitPublishDeniedError';
    this.source = source;
  }
}

/** replace/mute/unpublish was asked for a source that is not published. */
export class LiveKitNotPublishedError extends Error {
  public readonly source: LiveKitMediaSource;

  constructor(source: LiveKitMediaSource) {
    super(`LIVEKIT_NOT_PUBLISHED: ${source} is not published`);
    this.name = 'LiveKitNotPublishedError';
    this.source = source;
  }
}

/**
 * The browser cannot run LiveKit end-to-end encryption (no insertable streams / script transform).
 * A 1:1 call must fail visibly on this, never fall back to plaintext media.
 */
export class LiveKitE2eeUnsupportedError extends Error {
  constructor() {
    super('LIVEKIT_E2EE_UNSUPPORTED: this browser cannot encrypt call media end to end');
    this.name = 'LiveKitE2eeUnsupportedError';
  }
}

/** connect() did not reach the connected state. */
export class LiveKitConnectError extends Error {
  public readonly disconnectCause: LiveKitDisconnectCause;

  constructor(disconnectCause: LiveKitDisconnectCause, message: string) {
    super(`LIVEKIT_CONNECT_FAILED(${disconnectCause}): ${message}`);
    this.name = 'LiveKitConnectError';
    this.disconnectCause = disconnectCause;
  }
}
