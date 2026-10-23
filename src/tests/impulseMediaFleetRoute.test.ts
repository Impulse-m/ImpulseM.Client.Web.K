import {describe, expect, it} from 'vitest';

import {mediaFleetEndpointOf, routesToMediaFleet} from '@lib/impulse/media/mediaFleetRoute';


const FILE_TRANSFER_METHODS: string[] = [
  'upload.saveFilePart',
  'upload.saveBigFilePart',
  'upload.getFile',
  'upload.getWebFile'
];

const GATEWAY_METHODS: string[] = [
  'upload.getCdnFile',
  'upload.getFileHashes',
  'upload.getCdnFileHashes',
  'upload.reuploadCdnFile',
  'messages.sendMedia',
  'help.getConfig'
];

describe('the media fleet carries exactly the four file-transfer methods', () => {
  it.each(FILE_TRANSFER_METHODS)('routes %s to the fleet', (method: string) => {
    expect(
      routesToMediaFleet(method),
      `${method} is a file-transfer query: canon files.md:3292-3306 sends it to the media DC, not to the gateway`
    ).toBe(true);
  });

  it.each(GATEWAY_METHODS)('keeps %s on the gateway path', (method: string) => {
    expect(
      routesToMediaFleet(method),
      `${method} is not one of the four registry calls of the media fleet and must stay on gRPC-web`
    ).toBe(false);
  });
});

const CURRENT_DC: number = 2;
const FLEET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';

describe('the endpoint the media option names', () => {
  it('is the wss URL of the media_only entry for the current DC', () => {
    const config = {
      this_dc: CURRENT_DC,
      dc_options: [
        {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
        {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, media_only: true}
      ]
    };

    expect(
      mediaFleetEndpointOf(config),
      'the media_only entry of this_dc must become wss://{host}:{port}/connection/websocket with the protobuf query'
    ).toBe(`wss://media.impulsem.io:443${FLEET_PATH}`);
  });

  it('is undefined when the server publishes no media option', () => {
    const config = {
      this_dc: CURRENT_DC,
      dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]
    };

    expect(
      mediaFleetEndpointOf(config),
      'without a media_only entry the client must keep the gateway path, so no endpoint may be named'
    ).toBeUndefined();
  });

  it('ignores a media option of another DC', () => {
    const config = {
      this_dc: CURRENT_DC,
      dc_options: [{id: 3, ip_address: 'media.impulsem.io', port: 443, media_only: true}]
    };

    expect(
      mediaFleetEndpointOf(config),
      'a media plane of DC 3 does not serve the DC this client is on'
    ).toBeUndefined();
  });

  it('ignores the main entry of the current DC', () => {
    const config = {
      this_dc: CURRENT_DC,
      dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443, media_only: false}]
    };

    expect(
      mediaFleetEndpointOf(config),
      'an entry without media_only is the main connection, not the file-transfer plane'
    ).toBeUndefined();
  });

  it('brackets an IPv6 address', () => {
    const config = {
      this_dc: CURRENT_DC,
      dc_options: [{id: CURRENT_DC, ip_address: '2001:db8::1', port: 443, ipv6: true, media_only: true}]
    };

    expect(
      mediaFleetEndpointOf(config),
      'an IPv6 host must be bracketed in a URL'
    ).toBe(`wss://[2001:db8::1]:443${FLEET_PATH}`);
  });
});
