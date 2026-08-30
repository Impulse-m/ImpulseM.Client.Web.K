import {create, toBinary} from '@bufbuild/protobuf';
import {describe, expect, it} from 'vitest';

import {buildProtoInit} from '../lib/impulse/grpc/adapter';
import {DocumentAttributeAudioSchema} from '../lib/impulse/grpc/gen/v1/types_pb';


describe('gRPC adapter integer boundary', () => {
  it('truncates a fractional audio duration before protobuf serialization', () => {
    const init = buildProtoInit({duration: 1.0448}, DocumentAttributeAudioSchema);
    const message = create(DocumentAttributeAudioSchema, init);

    expect(message.duration).toBe(1);
    expect(() => toBinary(DocumentAttributeAudioSchema, message)).not.toThrow();
  });
});
