export const GROUP_CALL_AMPLITUDE_ANALYSE_COUNT_MAX = 50;
export const GROUP_CALL_AMPLITUDE_ANALYSE_INTERVAL_MS = 100;
export const GROUP_CALL_PARTICIPANTS_LOAD_LIMIT = 100;
// Enough to name a few people in the conference join confirmation and still
// know there are more — the same page size tdesktop asks for there
// (window_session_controller.cpp:985).
export const CONFERENCE_PREVIEW_PARTICIPANTS_LIMIT = 5;

export const enum GroupCallVideoQuality {
  Thumbnail = 0,
  Medium = 1,
  Full = 2
};

export const RTMP_UNIFIED_CHANNEL_ID = 1;
export const RTMP_UNIFIED_QUALITY = GroupCallVideoQuality.Full;

// How long a call may ring before it is given up on — the 1-on-1 request /
// accept window and, for want of the server's `call_ring_timeout_ms`, the age
// past which an incoming conference invitation is no longer offered.
export const CALL_REQUEST_TIMEOUT = 45e3;

// A second incoming call rings while another call is up (call waiting) —
// audible, but quiet enough not to drown the conversation.
export const CALL_WAITING_RING_VOLUME = 0.3;

// t.me/call/<slug>: the slug is an opaque token the server minted. Anything
// outside this alphabet is a malformed link, not something to resolve.
export const CONFERENCE_CALL_SLUG_REGEXP = /^[A-Za-z0-9_-]{1,64}$/;

// groupCallParticipant.volume is in 1/10000 of the nominal level; 10000 is 100%.
export const GROUP_CALL_PARTICIPANT_VOLUME_UNIT = 10000;
