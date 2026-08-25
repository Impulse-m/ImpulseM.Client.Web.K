import SDP from '@lib/calls/sdp';
import SDPMediaSection from '@lib/calls/sdp/mediaSection';
import {toImpulseMSource} from '@lib/calls/utils';
import {parseSourceGroups} from '@lib/calls/helpers/parseSourceGroups';

export default function parseMediaSectionInfo(sdp: SDP, channel: SDPMediaSection) {
  const clientInfo = channel.lookupAttributeKeys({
    'ice-ufrag': true,
    'ice-pwd': true,
    'fingerprint': true,
    'setup': true,
    'ssrc': true,
    'mid': true,
    'ssrc-group': false
  });

  if(!clientInfo.fingerprint) { // support Firefox
    const line = sdp.session.lines.find((line) => line.parsed?.key === 'fingerprint');
    clientInfo.fingerprint = line.parsed.value;
  }

  const impulsemSourceGroups = parseSourceGroups(clientInfo['ssrc-group']);
  const [hash, fingerprint] = clientInfo.fingerprint.split(' ', 2);
  const ssrc = clientInfo.ssrc && toImpulseMSource(+clientInfo.ssrc.split(' ', 1)[0]);
  // ssrc = impulsemSourceGroups ? impulsemSourceGroups[0].sources[0] : ssrc;

  return {
    raw: clientInfo,
    ufrag: clientInfo['ice-ufrag'],
    pwd: clientInfo['ice-pwd'],
    fingerprint: {
      fingerprint,
      setup: clientInfo.setup,
      hash
    },
    source: ssrc,
    sourceGroups: impulsemSourceGroups,
    mid: clientInfo.mid
  };
}
