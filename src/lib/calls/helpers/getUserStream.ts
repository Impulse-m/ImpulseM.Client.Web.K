import {appSettings} from '@stores/appSettings';
import getStream from '@lib/calls/helpers/getStream';

export const IS_ECHO_CANCELLATION_SUPPORTED = navigator?.mediaDevices?.getSupportedConstraints().echoCancellation;
export const IS_NOISE_SUPPRESSION_SUPPORTED = navigator?.mediaDevices?.getSupportedConstraints().noiseSuppression;

export type StreamType = 'audio' | 'video' | 'presentation';


export function getUserStream(streamType: StreamType, facing: VideoFacingModeEnum = 'user') {
  if(streamType === 'presentation') {
    return (navigator.mediaDevices as any).getDisplayMedia({
      audio: false,
      video: true
    });
  }

  // Honour the device picked in the in-call settings popup / "Speakers and
  // Camera" tab. Without this, toggling video off/on (or accepting an
  // incoming call) re-grabs the OS-default camera regardless of what the
  // user picked. Group calls already route their constraints through the
  // shared get*Constraints helpers — do the same here so the two paths
  // stay in sync.
  const audioId = appSettings.callDevices?.microphoneId;
  const audio = streamType === 'audio' ? {
    echoCancellation: IS_ECHO_CANCELLATION_SUPPORTED ? true : undefined,
    noiseSuppression: IS_NOISE_SUPPRESSION_SUPPORTED ?
      (appSettings.callDevices?.noiseSuppression ?? true) :
      undefined,
    deviceId: audioId ? {exact: audioId} : undefined
  } : false;

  // `facingMode` only matters on mobile (front vs rear camera) — paired with
  // an explicit `deviceId: {exact: ...}` it can produce OverconstrainedError
  // on desktop where the chosen camera doesn't advertise a facingMode. Pick
  // ONE: prefer the explicit deviceId, fall back to facingMode.
  const videoId = appSettings.callDevices?.cameraId;
  const video = streamType === 'video' ? (
    videoId ?
      {deviceId: {exact: videoId}} :
      {facingMode: facing}
  ) : false;

  // Stale-deviceId recovery and incremental retry live inside `getStream`.
  return getStream({audio, video});
}

export function getStreamTrack(stream: MediaStream | undefined) {
  return stream?.getTracks()[0];
}

export function stopStream(stream?: MediaStream, except?: MediaStream) {
  if(!stream || stream === except) {
    return;
  }

  stream.getTracks().forEach((track) => {
    track.stop();
  });
}
