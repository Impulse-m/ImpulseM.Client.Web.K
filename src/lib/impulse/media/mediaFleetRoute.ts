/*
 * The file-transfer queries that travel the media fleet, and the endpoint the server names for them.
 *
 * Canon api/files.md:3292-3306: large file queries go to the media DC with the required DC ID, and the
 * server flags that DC's dcOption with media_only (constructor/dcOption.md). The fleet serves exactly
 * the four registry calls of deploy/centrifugo/media/registry.json.
 */

const MEDIA_FLEET_METHODS: ReadonlySet<string> = new Set<string>([
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
]);

const FLEET_CONNECTION_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';

export type MediaFleetDcOption = {
  id: number,
  ip_address: string,
  port: number,
  ipv6?: boolean,
  media_only?: boolean
};

export type MediaFleetConfig = {
  this_dc: number,
  dc_options: MediaFleetDcOption[]
};

export function routesToMediaFleet(method: string): boolean {
  return MEDIA_FLEET_METHODS.has(method);
}

export function mediaFleetEndpointOf(config: MediaFleetConfig): string | undefined {
  const option = config.dc_options.find((entry: MediaFleetDcOption): boolean => {
    return entry.id === config.this_dc && entry.media_only === true;
  });
  if(!option) {
    return undefined;
  }

  const host = option.ipv6 ? `[${option.ip_address}]` : option.ip_address;
  return `wss://${host}:${option.port}${FLEET_CONNECTION_PATH}`;
}
