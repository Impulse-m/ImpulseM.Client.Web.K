import {describe, expect, it} from 'vitest';
import {fromBinary} from '@bufbuild/protobuf';

import App from '@config/app';
import {connectionIdentityRequest} from '@lib/impulse/identity';
import {ConnectionIdentityRequestSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';

describe('connectionIdentity request builder', () => {
  it('builds a mint with an empty token and the app api id', () => {
    const request = fromBinary(ConnectionIdentityRequestSchema, connectionIdentityRequest(''));

    expect(request.identityToken).toBe('');
    expect(request.apiId).toBe(App.id);
  });

  it('builds a renewal that carries the current identity token and the app api id', () => {
    const request = fromBinary(ConnectionIdentityRequestSchema, connectionIdentityRequest('i-token'));

    expect(request.identityToken).toBe('i-token');
    expect(request.apiId).toBe(App.id);
  });
});
