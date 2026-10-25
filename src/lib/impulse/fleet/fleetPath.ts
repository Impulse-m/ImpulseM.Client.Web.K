/*
 * The Centrifugo WebSocket path of the gateway: the update socket and the fleets reach one endpoint path. A pool endpoint is
 * a full URL, so the protocol and the frame options of the fleet connections are written into its query here.
 */

export const CENTRIFUGO_CONNECTION_PATH: string = '/connection/websocket';
export const FLEET_CONNECTION_PATH: string = `${CENTRIFUGO_CONNECTION_PATH}?cf_protocol=protobuf&cf_ws_frame_ping_pong=true`;

export const POOL_CONNECTION_PATH: string = `/pool${FLEET_CONNECTION_PATH}`;
