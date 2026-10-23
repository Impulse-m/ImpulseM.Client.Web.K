/*
 * gRPC-web framing for the tests that stand in for the gateway. A frame is a flag byte, a big-endian length and the
 * payload. A unary reply is one message frame followed by the trailer frame, whose flag marks it as trailers.
 */

export type GrpcWebFrame = {flags: number, payload: Uint8Array};

export type GrpcWebResponse = {status: number, headers: Headers, body: ReadableStream<Uint8Array>};

export const GRPC_WEB_MESSAGE_FLAGS: number = 0;
export const GRPC_WEB_TRAILER_FLAGS: number = 0x80;

const FRAME_HEADER_BYTES: number = 5;
const LENGTH_OFFSET: number = 1;
const OK_TRAILERS: string = 'grpc-status:0\r\n';

export function grpcWebFrame(flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(LENGTH_OFFSET, payload.length);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export function splitGrpcWebFrames(body: Uint8Array): GrpcWebFrame[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: GrpcWebFrame[] = [];
  let offset = 0;
  while(offset < body.byteLength) {
    const length = view.getUint32(offset + LENGTH_OFFSET);
    const start = offset + FRAME_HEADER_BYTES;
    frames.push({flags: view.getUint8(offset), payload: body.subarray(start, start + length)});
    offset = start + length;
  }

  return frames;
}

export function joinGrpcWebFrames(frames: GrpcWebFrame[]): Uint8Array {
  const encoded = frames.map((frame: GrpcWebFrame): Uint8Array => grpcWebFrame(frame.flags, frame.payload));
  const out = new Uint8Array(encoded.reduce((sum: number, frame: Uint8Array): number => sum + frame.length, 0));
  let written = 0;
  for(const frame of encoded) {
    out.set(frame, written);
    written += frame.length;
  }

  return out;
}

export function grpcWebResponse(body: Uint8Array): GrpcWebResponse {
  return {
    status: 200,
    headers: new Headers({'content-type': 'application/grpc-web+proto'}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      }
    })
  };
}

/** A successful unary reply: the message, then the trailers with grpc-status 0. */
export function grpcWebUnaryReply(payload: Uint8Array = new Uint8Array(0)): GrpcWebResponse {
  return grpcWebResponse(joinGrpcWebFrames([
    {flags: GRPC_WEB_MESSAGE_FLAGS, payload},
    {flags: GRPC_WEB_TRAILER_FLAGS, payload: new TextEncoder().encode(OK_TRAILERS)}
  ]));
}

/** A trailers-only reply: grpc-status and any custom trailers, with no message frame. */
export function grpcWebTrailersOnly(trailers: string): GrpcWebResponse {
  return grpcWebResponse(grpcWebFrame(GRPC_WEB_TRAILER_FLAGS, new TextEncoder().encode(trailers)));
}
