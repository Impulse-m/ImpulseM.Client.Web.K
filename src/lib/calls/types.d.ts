// What the call UI reads about one side of a 1:1 call. The remote side is derived from LiveKit track state.
export type CallMediaState = {
  '@type': 'MediaState',
  type?: 'input' | 'output',
  lowBattery: boolean,
  muted: boolean,
  screencastState: 'active' | 'inactive',
  videoRotation: number,
  videoState: CallMediaState['screencastState']
};

export type DiffieHellmanInfo = DiffieHellmanInfo.a | DiffieHellmanInfo.b;

export namespace DiffieHellmanInfo {
  export type a = {
    a: Uint8Array,
    g_a: Uint8Array,
    g_a_hash: Uint8Array,
    p: Uint8Array,
  };

  export type b = {
    b: Uint8Array,
    g_b: Uint8Array,
    g_b_hash: Uint8Array,
    p: Uint8Array,
  };
}

export type CallType = 'video' | 'voice';

declare global {
  interface MediaStream {
    source?: string;
  }
}
