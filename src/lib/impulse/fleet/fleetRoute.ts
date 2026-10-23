/*
 * Which carrier serves a call, and where the media fleet listens.
 *
 * Canon api/files.md:3302-3306: a file query must go to the media DC when that DC has a dcOption with the media flag
 * (constructor/dcOption.md, media_only). The media fleet serves exactly the four registry calls of
 * deploy/centrifugo/media/registry.json. Every other call is an rpc on the update socket (realtime.ts).
 */

import {backendWsOrigin} from '@config/backendOrigin';

const MEDIA_FLEET_METHODS: ReadonlySet<string> = new Set<string>([
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
]);

// The client's own calls are not canon methods; the server registers them under these keys.
export const REFRESH_SESSION_METHOD: string = 'impulse.auth.refreshSession';
export const INIT_CONNECTION_METHOD: string = 'impulse.auth.initConnection';

export const FLEET_CONNECTION_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
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

export function routesToMediaFleet(method: string): boolean {
  return MEDIA_FLEET_METHODS.has(method);
}

export function mediaEndpointOf(config: FleetConfig): string | undefined {
  const option = config.dc_options.find((entry: FleetDcOption): boolean => {
    return entry.id === config.this_dc && entry.pFlags?.media_only === true;
  });

  return option === undefined ? undefined : endpointOf(option);
}

/** The endpoint of the anonymous pool the session refresh uses: the host of the update socket, on port 443. */
export function defaultRpcEndpoint(): string {
  const origin = new URL(backendWsOrigin());
  return `${origin.protocol}//${origin.hostname}:${origin.port || DEFAULT_FLEET_PORT}${FLEET_CONNECTION_PATH}`;
}

function endpointOf(option: FleetDcOption): string {
  const host = option.pFlags?.ipv6 === true ? `[${option.ip_address}]` : option.ip_address;
  return `wss://${host}:${option.port}${FLEET_CONNECTION_PATH}`;
}
