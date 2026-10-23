/*
 * Which carrier serves a call, and where the media fleet listens.
 *
 * Canon api/files.md:3302-3306: a file query must go to the media DC when that DC has a dcOption with the media flag
 * (constructor/dcOption.md, media_only). The media fleet serves exactly the four registry calls of
 * deploy/centrifugo/media/registry.json. Every other call is an rpc on the update socket (realtime.ts).
 */

import {backendHttpOrigin, backendWsOrigin} from '@config/backendOrigin';
import type {FleetConfig} from './fleetEndpoint';
import {endpointOf, mediaOptionOf} from './fleetEndpoint';
import {FLEET_CONNECTION_PATH} from './fleetPath';

export type {FleetConfig, FleetDcOption} from './fleetEndpoint';

const MEDIA_FLEET_METHODS: ReadonlySet<string> = new Set<string>([
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
]);

// The client's own calls are not canon methods; the server registers them under these keys.
export const REFRESH_SESSION_METHOD: string = 'impulse.auth.refreshSession';
export const INIT_CONNECTION_METHOD: string = 'impulse.auth.initConnection';

const DEFAULT_FLEET_PORT: string = '443';

export function routesToMediaFleet(method: string): boolean {
  return MEDIA_FLEET_METHODS.has(method);
}

export function mediaEndpointOf(config: FleetConfig): string | undefined {
  const option = mediaOptionOf(config);
  return option === undefined ? undefined : endpointOf(option);
}

/** The endpoint of the anonymous pool the session refresh uses: the host of the update socket, on port 443. */
export function defaultRpcEndpoint(): string {
  const origin = new URL(backendWsOrigin(backendHttpOrigin()));
  return `${origin.protocol}//${origin.hostname}:${origin.port || DEFAULT_FLEET_PORT}${FLEET_CONNECTION_PATH}`;
}
