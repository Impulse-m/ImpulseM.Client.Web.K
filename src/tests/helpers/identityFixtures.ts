import {create, toBinary} from '@bufbuild/protobuf';
import {ConnectionIdentityResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';

export const now: number = 1_700_000_000;

export function jwt(claims: Record<string, unknown>): string {
  return `e30.${btoa(JSON.stringify(claims)).replace(/=/g, '')}.signature`;
}

export const identityToken: string = jwt({sub: 'i:first', exp: now + 3600, iat: now, orig_iat: now});
export const accessToken: string = jwt({sub: '42', exp: now + 3600, iat: now});

export function identityReply(token: string): {data: Uint8Array} {
  return {data: toBinary(ConnectionIdentityResponseSchema, create(ConnectionIdentityResponseSchema, {identityToken: token}))};
}

export function freshIdentityReply(): {data: Uint8Array} {
  const issued: number = Math.floor(Date.now() / 1000);
  return identityReply(jwt({sub: 'i:fixture', iat: issued, orig_iat: issued, exp: issued + 3600}));
}
