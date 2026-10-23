import {describe, expect, it} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';

import {backendWsOrigin} from '@config/backendOrigin';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
import {
  defaultRpcEndpoint,
  INIT_CONNECTION_METHOD,
  mediaEndpointOf,
  REFRESH_SESSION_METHOD,
  routesToMediaFleet
} from '@lib/impulse/fleet/fleetRoute';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {protoToTL} from '@lib/impulse/grpc/protoToTL';
import {ConfigSchema, DcOptionSchema} from '@lib/impulse/grpc/gen/v1/types_pb';


const FILE_TRANSFER_METHODS: string[] = [
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
];

const REGULAR_METHODS: string[] = [
  'upload.getCdnFile',
  'upload.getFileHashes',
  'upload.getCdnFileHashes',
  'upload.reuploadCdnFile',
  'messages.sendMedia',
  'help.getConfig'
];

const CURRENT_DC: number = 2;
const MAIN_HOST: string = '149.154.167.50';

const WITHOUT_MEDIA_OPTION: FleetConfig = {
  this_dc: CURRENT_DC,
  dc_options: [{id: CURRENT_DC, ip_address: MAIN_HOST, port: 443}]
};

describe('the media fleet carries exactly the four file-transfer methods', () => {
  it.each(FILE_TRANSFER_METHODS)('routes %s to the media fleet', (method: string) => {
    expect(
      routesToMediaFleet(method),
      `${method} is a file-transfer query: canon api/files.md:3302-3306 sends it to the media DC`
    ).toBe(true);
  });

  it.each(REGULAR_METHODS)('keeps %s off the media fleet, on the update socket', (method: string) => {
    expect(
      routesToMediaFleet(method),
      `${method} is not one of the four registry calls of the media fleet`
    ).toBe(false);
  });
});

describe('the refresh endpoint is the host of the update socket', () => {
  it('is the wss URL of the configured host on port 443 with the protobuf query', () => {
    expect(
      defaultRpcEndpoint(),
      'the stand names rpc.impulsem.io in VITE_IMPULSE_BACKEND_URL; the anonymous refresh pool connects to that host'
    ).toBe(`wss://rpc.impulsem.io:443${FLEET_CONNECTION_PATH}`);
    expect(backendWsOrigin()).toBe('wss://rpc.impulsem.io');
  });
});

describe('the endpoint the media option names', () => {
  it('is read from a help.getConfig reply as the server encodes it, where the dcOption flags are decoded', () => {
    const encoded = toBinary(ConfigSchema, create(ConfigSchema, {
      thisDc: CURRENT_DC,
      dcOptions: [
        create(DcOptionSchema, {id: CURRENT_DC, ipAddress: MAIN_HOST, port: 443}),
        create(DcOptionSchema, {id: CURRENT_DC, ipAddress: 'media.impulsem.io', port: 443, mediaOnly: true})
      ]
    }));
    const config = protoToTL(fromBinary(ConfigSchema, encoded), ConfigSchema);

    expect(
      mediaEndpointOf(config),
      'media_only is a TL flag (constructor/dcOption.md flags.1?true): the decoded reply keeps it in pFlags, and the endpoint must be read from there'
    ).toBe(`wss://media.impulsem.io:443${FLEET_CONNECTION_PATH}`);
  });

  it('is the wss URL of the media_only entry for the current DC', () => {
    const config: FleetConfig = {
      this_dc: CURRENT_DC,
      dc_options: [
        {id: CURRENT_DC, ip_address: MAIN_HOST, port: 443},
        {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
      ]
    };

    expect(
      mediaEndpointOf(config),
      'the media_only entry of this_dc must become wss://{host}:{port} with the fleet connection path and its protobuf query'
    ).toBe(`wss://media.impulsem.io:443${FLEET_CONNECTION_PATH}`);
  });

  it('is undefined when the server publishes no media option', () => {
    expect(mediaEndpointOf(WITHOUT_MEDIA_OPTION)).toBeUndefined();
  });

  it('ignores a media option of another DC', () => {
    expect(
      mediaEndpointOf({
        this_dc: CURRENT_DC,
        dc_options: [{id: 3, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}]
      }),
      'a media plane of DC 3 does not serve the DC this client is on'
    ).toBeUndefined();
  });

  it('ignores the main entry of the current DC', () => {
    expect(
      mediaEndpointOf({
        this_dc: CURRENT_DC,
        dc_options: [{id: CURRENT_DC, ip_address: MAIN_HOST, port: 443, pFlags: {media_only: false}}]
      }),
      'an entry without media_only is the main connection, not the file-transfer plane'
    ).toBeUndefined();
  });

  it('brackets an IPv6 address', () => {
    expect(
      mediaEndpointOf({
        this_dc: CURRENT_DC,
        dc_options: [{id: CURRENT_DC, ip_address: '2001:db8::1', port: 443, pFlags: {ipv6: true, media_only: true}}]
      }),
      'an IPv6 host must be bracketed in a URL'
    ).toBe(`wss://[2001:db8::1]:443${FLEET_CONNECTION_PATH}`);
  });
});

describe('the internal calls of the client carry their own registry keys', () => {
  it('names the refresh and the connection declaration calls', () => {
    expect(REFRESH_SESSION_METHOD).toBe('impulse.auth.refreshSession');
    expect(INIT_CONNECTION_METHOD).toBe('impulse.auth.initConnection');
  });

  it('keeps neither of them on the media fleet', () => {
    expect([REFRESH_SESSION_METHOD, INIT_CONNECTION_METHOD].some(routesToMediaFleet)).toBe(false);
  });
});
