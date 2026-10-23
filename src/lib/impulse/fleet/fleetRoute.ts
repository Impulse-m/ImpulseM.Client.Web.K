/*
 * Which fleet carries a call, and where each fleet listens.
 *
 * Canon api/files.md:3302-3306: a file query must go to the media DC when that DC has a dcOption with the media
 * flag (constructor/dcOption.md, media_only). The media fleet serves exactly the four registry calls of
 * deploy/centrifugo/media/registry.json. Every other call travels the RPC fleet, which listens at the main dcOption
 * of this DC; until the server publishes that option the configured host carries the calls.
 */

import {backendWsOrigin} from '@config/backendOrigin';

const MEDIA_FLEET_METHODS: ReadonlySet<string> = new Set<string>([
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
]);

// The client's own calls are not canon methods; the fleets register them under these keys.
export const REFRESH_SESSION_METHOD: string = 'impulse.auth.refreshSession';
export const INIT_CONNECTION_METHOD: string = 'impulse.auth.initConnection';
export const GET_CENTRIFUGO_TOKEN_METHOD: string = 'impulse.sync.getCentrifugoToken';

const FLEET_CONNECTION_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
const DEFAULT_FLEET_PORT: string = '443';

// The TL flags of a dcOption (constructor/dcOption.md) are decoded into pFlags, as protoToTL places every flags.N?true.
export type FleetDcOption = {
  id: number,
  ip_address: string,
  port: number,
  pFlags?: {ipv6?: boolean, media_only?: boolean}
};

export type FleetConfig = {
  this_dc: number,
  dc_options: FleetDcOption[]
};

export type FleetEndpoints = {
  rpc: string,
  media: string | undefined
};

export function routesToMediaFleet(method: string): boolean {
  return MEDIA_FLEET_METHODS.has(method);
}

/** The RPC fleet of the config, or the configured host on port 443 until the config names one for this DC. */
export function fleetEndpointsOf(config: FleetConfig): FleetEndpoints {
  return {
    rpc: rpcEndpointOf(config) ?? defaultRpcEndpoint(),
    media: mediaEndpointOf(config)
  };
}

export function rpcEndpointOf(config: FleetConfig): string | undefined {
  const option = config.dc_options.find((entry: FleetDcOption): boolean => {
    return entry.id === config.this_dc && entry.pFlags?.media_only !== true;
  });

  return option === undefined ? undefined : endpointOf(option);
}

export function mediaEndpointOf(config: FleetConfig): string | undefined {
  const option = config.dc_options.find((entry: FleetDcOption): boolean => {
    return entry.id === config.this_dc && entry.pFlags?.media_only === true;
  });

  return option === undefined ? undefined : endpointOf(option);
}

export function defaultRpcEndpoint(): string {
  const origin = new URL(backendWsOrigin());
  return `${origin.protocol}//${origin.hostname}:${origin.port || DEFAULT_FLEET_PORT}${FLEET_CONNECTION_PATH}`;
}

function endpointOf(option: FleetDcOption): string {
  const host = option.pFlags?.ipv6 === true ? `[${option.ip_address}]` : option.ip_address;
  return `wss://${host}:${option.port}${FLEET_CONNECTION_PATH}`;
}
