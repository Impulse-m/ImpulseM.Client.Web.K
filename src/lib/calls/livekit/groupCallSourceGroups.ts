/** One `ssrc-groups` entry of a join payload (tgcalls shape). Sources are unsigned 32-bit and non-zero. */
export type JoinSourceGroup = {
  semantics: 'SIM' | 'FID',
  sources: number[]
};

/** Simulcast layers of a camera, each with its retransmission source. */
export const CAMERA_SIMULCAST_LAYERS = 3;

/**
 * The source groups a camera declares: one SIM group over the simulcast layers and one FID group per layer
 * (layer, retransmission). The server echoes them as `participant.video.source_groups` and emits `video`
 * only when some were declared, so the main connection always declares them: the camera can then be turned
 * on at any time. Four groups of two to three sources each are inside the server's bounds (8 groups, 8 sources).
 */
export function makeCameraSourceGroups(options: {draw: () => number, taken: Iterable<number>}): JoinSourceGroup[] {
  const used = new Set<number>(options.taken);
  const unique = (): number => {
    for(;;) {
      const source = options.draw();
      if(source >= 1 && source <= 0xFFFFFFFF && !used.has(source)) {
        used.add(source);
        return source;
      }
    }
  };

  const layers: number[] = Array.from({length: CAMERA_SIMULCAST_LAYERS}, unique);
  return [
    {semantics: 'SIM', sources: layers},
    ...layers.map((layer): JoinSourceGroup => ({semantics: 'FID', sources: [layer, unique()]}))
  ];
}

/** The source groups a screen share declares: one stream and its retransmission source. */
export function makeScreenSourceGroups(options: {draw: () => number, taken: Iterable<number>}): JoinSourceGroup[] {
  const [, fid] = makeCameraSourceGroups(options);
  return [{semantics: 'FID', sources: fid.sources}];
}
