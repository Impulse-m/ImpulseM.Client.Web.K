import {GroupCallParticipantVideoSourceGroup} from '@layer';
import {toImpulseMSource} from '@lib/calls/utils';

export function parseSourceGroups(sdpLines: string[]) {
  const impulsemSourceGroups = sdpLines.map((str) => {
    const [semantics, ...rest] = str.split(' ');

    const sourceGroup: GroupCallParticipantVideoSourceGroup = {
      _: 'groupCallParticipantVideoSourceGroup',
      semantics,
      // sources: rest.map((ssrc) => +ssrc)
      sources: rest.map((ssrc) => toImpulseMSource(+ssrc))
    };

    return sourceGroup;
  });

  /* const simIndex = impulsemSourceGroups.findIndex((g) => g.semantics === 'SIM');
  if(simIndex !== -1) {
    const sourceGroup = impulsemSourceGroups.splice(simIndex, 1)[0];
    impulsemSourceGroups.unshift(sourceGroup);
  } */

  return impulsemSourceGroups.length ? impulsemSourceGroups : undefined;
}
