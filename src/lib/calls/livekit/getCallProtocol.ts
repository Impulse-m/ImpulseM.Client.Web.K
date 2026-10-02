import {PhoneCallProtocol} from '@layer';

/**
 * The only call protocol this client speaks: 1:1 media over LiveKit, end-to-end encrypted with a key derived
 * from the call's DH auth key (see livekit/callMediaKey.ts). tgcalls peers ('13.0.0' and older) share no
 * version with it, so a call with one ends through the incompatible-peer path.
 */
export const LIVEKIT_CALL_PROTOCOL_VERSION = 'impulsem-livekit-1';

export const CALL_PROTOCOL_LIBRARY_VERSIONS = [LIVEKIT_CALL_PROTOCOL_VERSION];

export default function getCallProtocol(): PhoneCallProtocol {
  return {
    _: 'phoneCallProtocol',
    pFlags: {
      udp_p2p: true,
      udp_reflector: true
    },
    min_layer: 65,
    max_layer: 92,
    library_versions: CALL_PROTOCOL_LIBRARY_VERSIONS
  };
}
