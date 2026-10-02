// Calls run on LiveKit, which works in every browser with WebRTC, Firefox included. A 1:1 call additionally
// needs end-to-end media encryption and refuses to start without it (assertLiveKitE2eeSupported).
const IS_WEBRTC_SUPPORTED = !!(typeof(RTCPeerConnection) !== 'undefined');

export default IS_WEBRTC_SUPPORTED;
