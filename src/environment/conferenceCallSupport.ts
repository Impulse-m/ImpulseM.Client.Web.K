// Conference (TdE2E-encrypted group) calls are OFF. This backend does not offer them (it answers
// METHOD_INVALID) and the media layer is LiveKit, which has no place for the per-SSRC script transforms the
// conference media path was built on. The key and chain implementation stays under src/lib/calls/e2e/;
// the controller's conference entry points refuse with ConferenceUnsupportedError before any media.
const IS_CONFERENCE_CALL_ENABLED = false;

const IS_CONFERENCE_CALL_SUPPORTED = IS_CONFERENCE_CALL_ENABLED;

export default IS_CONFERENCE_CALL_SUPPORTED;
