/**
 * Conference (end-to-end encrypted group) calls and RTMP livestreams do not exist on this backend, and the
 * media layer is LiveKit: an entry point that would start one refuses before any capture or request.
 */
export default class ConferenceUnsupportedError extends Error {
  constructor() {
    super('CONFERENCE_UNSUPPORTED: conference calls are not available');
    this.name = 'ConferenceUnsupportedError';
  }
}
