import {describe, expect, it} from 'vitest';
import {create} from '@bufbuild/protobuf';

import {BoolResponseSchema} from './gen/v1/types_pb';
import {protoToTL} from './protoToTL';


describe('protoToTL v1.BoolResponse', () => {
  it('maps value=false to boolFalse', () => {
    expect(protoToTL(create(BoolResponseSchema, {value: false}))).toBe(false);
  });

  it('maps value=true to boolTrue', () => {
    expect(protoToTL(create(BoolResponseSchema, {value: true}))).toBe(true);
  });

  it('fails visibly when the server omits the value', () => {
    expect(() => protoToTL(create(BoolResponseSchema))).toThrow(/BoolResponse arrived without a value/);
  });
});
