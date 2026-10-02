import {describe, expect, it} from 'vitest';
import {makeCameraSourceGroups, makeScreenSourceGroups} from '@lib/calls/livekit/groupCallSourceGroups';

// the bounds the backend parser enforces (GroupCallJoinPayload.cs): 8 groups, 8 sources each, 1..0xFFFFFFFF
const MAX_GROUPS = 8;
const MAX_SOURCES = 8;

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

describe('join source groups', () => {
  it('declares a SIM group over the layers and a FID pair per layer for the camera', () => {
    const groups = makeCameraSourceGroups({draw: sequence([10, 11, 12, 20, 21, 22]), taken: []});

    expect(groups).toEqual([
      {semantics: 'SIM', sources: [10, 11, 12]},
      {semantics: 'FID', sources: [10, 20]},
      {semantics: 'FID', sources: [11, 21]},
      {semantics: 'FID', sources: [12, 22]}
    ]);
  });

  it('stays inside what the server accepts and never repeats a source', () => {
    const draws = [0, 0xFFFFFFFF, 5, 5, 6, 0xFFFFFFFF, 7, 8, 9, 10, 11, 12];
    const groups = makeCameraSourceGroups({draw: sequence(draws), taken: []});
    const all = groups.flatMap((group) => group.sources);

    expect(groups.length).toBeLessThanOrEqual(MAX_GROUPS);
    for(const group of groups) {
      expect(group.sources.length).toBeGreaterThanOrEqual(1);
      expect(group.sources.length).toBeLessThanOrEqual(MAX_SOURCES);
    }
    expect(all.every((source) => Number.isInteger(source) && source >= 1 && source <= 0xFFFFFFFF)).toBe(true);
    // SIM repeats the layers inside the FID groups; every distinct source is declared once as a layer or an rtx
    expect(new Set([...groups[0].sources, ...groups.slice(1).map((group) => group[('sources')][1])]).size).toBe(6);
  });

  it('does not reuse a source that is already ours (the audio source, the main connection)', () => {
    const groups = makeCameraSourceGroups({draw: sequence([5, 6, 7, 8, 9, 10, 11, 12]), taken: [5, 8]});
    expect(groups.flatMap((group) => group.sources)).not.toContain(5);
    expect(groups.flatMap((group) => group.sources)).not.toContain(8);
  });

  it('declares one FID stream for a screen share', () => {
    const groups = makeScreenSourceGroups({draw: sequence([30, 31, 32, 40, 41, 42]), taken: []});
    expect(groups).toEqual([{semantics: 'FID', sources: [30, 40]}]);
  });
});
