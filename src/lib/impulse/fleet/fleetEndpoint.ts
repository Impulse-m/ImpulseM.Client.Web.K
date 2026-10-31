/* Imports only fleetPath, so the live e2e lane can load it without the client runtime. */

import {FLEET_CONNECTION_PATH} from './fleetPath';

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

export function mediaOptionOf(config: FleetConfig): FleetDcOption | undefined {
  return config.dc_options.find((entry: FleetDcOption): boolean => {
    return entry.id === config.this_dc && entry.pFlags?.media_only === true;
  });
}

export function endpointOf(option: FleetDcOption): string {
  const host = option.pFlags?.ipv6 === true ? `[${option.ip_address}]` : option.ip_address;
  return `wss://${host}:${option.port}${FLEET_CONNECTION_PATH}`;
}
