import {describe, expect, it} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';

import {backendWsOrigin} from '@config/backendOrigin';
import {
  defaultRpcEndpoint,
  fleetEndpointsOf,
  GET_CENTRIFUGO_TOKEN_METHOD,
  INIT_CONNECTION_METHOD,
  mediaEndpointOf,
  REFRESH_SESSION_METHOD,
  routesToMediaFleet,
  rpcEndpointOf
} from '@lib/impulse/fleet/fleetRoute';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {protoToTL} from '@lib/impulse/grpc/adapter';
import {ConfigSchema, DcOptionSchema} from '@lib/impulse/grpc/gen/v1/types_pb';


const FILE_TRANSFER_METHODS: string[] = [
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
];

const RPC_FLEET_METHODS: string[] = [
  'upload.getCdnFile',
  'upload.getFileHashes',
  'upload.getCdnFileHashes',
  'upload.reuploadCdnFile',
  'messages.sendMedia',
  'help.getConfig'
];

const CURRENT_DC: number = 2;
const FLEET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
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

  it.each(RPC_FLEET_METHODS)('keeps %s on the RPC fleet, not the media fleet', (method: string) => {
    expect(
      routesToMediaFleet(method),
      `${method} is not one of the four registry calls of the media fleet`
    ).toBe(false);
  });
});

describe('the RPC fleet is the main dcOption of this DC, or the configured host before the first config', () => {
  it('is the wss URL of the main entry of the current DC', () => {
    expect(
      rpcEndpointOf({
        this_dc: CURRENT_DC,
        dc_options: [
          {id: CURRENT_DC, ip_address: MAIN_HOST, port: 443},
          {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
        ]
      }),
      'the main dcOption of this_dc is the RPC fleet, the media_only entry is not'
    ).toBe(`wss://${MAIN_HOST}:443${FLEET_PATH}`);
  });

  it('ignores a main entry of another DC', () => {
    expect(
      rpcEndpointOf({
        this_dc: CURRENT_DC,
        dc_options: [{id: 3, ip_address: MAIN_HOST, port: 443}]
      }),
      'the RPC fleet of DC 3 does not serve the DC this client is on'
    ).toBeUndefined();
  });

  it('is the configured host on port 443 before the first config is known', () => {
    expect(
      defaultRpcEndpoint(),
      'the stand names rpc.impulsem.io in VITE_IMPULSE_BACKEND_URL; before help.getConfig that host carries the calls'
    ).toBe(`wss://rpc.impulsem.io:443${FLEET_PATH}`);
    expect(backendWsOrigin()).toBe('wss://rpc.impulsem.io');
  });

  it('falls back to the configured host when the config names no main entry for this DC', () => {
    expect(fleetEndpointsOf({this_dc: CURRENT_DC, dc_options: []}).rpc).toBe(defaultRpcEndpoint());
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
    ).toBe(`wss://media.impulsem.io:443${FLEET_PATH}`);
    expect(
      rpcEndpointOf(config),
      'the main entry is the one without the media flag, however the reply orders its entries'
    ).toBe(`wss://${MAIN_HOST}:443${FLEET_PATH}`);
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
      'the media_only entry of this_dc must become wss://{host}:{port}/connection/websocket with the protobuf query'
    ).toBe(`wss://media.impulsem.io:443${FLEET_PATH}`);
    expect(fleetEndpointsOf(config).media).toBe(`wss://media.impulsem.io:443${FLEET_PATH}`);
  });

  it('is undefined when the server publishes no media option, so the file calls travel the RPC fleet', () => {
    expect(mediaEndpointOf(WITHOUT_MEDIA_OPTION)).toBeUndefined();
    expect(fleetEndpointsOf(WITHOUT_MEDIA_OPTION).media).toBeUndefined();
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
    ).toBe(`wss://[2001:db8::1]:443${FLEET_PATH}`);
  });
});

describe('the internal calls of the client carry their own registry keys', () => {
  it('names the refresh, the connection declaration and the Centrifugo token calls', () => {
    expect(REFRESH_SESSION_METHOD).toBe('impulse.auth.refreshSession');
    expect(INIT_CONNECTION_METHOD).toBe('impulse.auth.initConnection');
    expect(GET_CENTRIFUGO_TOKEN_METHOD).toBe('impulse.sync.getCentrifugoToken');
  });

  it('keeps none of them on the media fleet', () => {
    expect([REFRESH_SESSION_METHOD, INIT_CONNECTION_METHOD, GET_CENTRIFUGO_TOKEN_METHOD].some(routesToMediaFleet)).toBe(false);
  });
});
