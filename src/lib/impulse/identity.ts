import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {UnauthorizedError} from '@impulsem/centrifuge/build/protobuf';
import App from '@config/app';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {callPool, resetFleetIdentity} from '@lib/impulse/fleet/fleet';
import {CONNECTION_IDENTITY_METHOD} from '@lib/impulse/fleet/fleetRoute';
import {callUpdateSocket, rekeyUpdateSocket} from '@lib/impulse/realtime';
import {scheduleTokenRenewal} from '@lib/impulse/tokenRenewal';
import {resetConnectionInited} from '@lib/impulse/grpc/credentials';
import tokenClaims from '@helpers/jwtClaims';
import {ConnectionIdentityRequestSchema, ConnectionIdentityResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';

type IdentityToken = {token: string, sub: string, exp: number, origIat: number, iat: number};
type IdentitySlot = {
  value?: IdentityToken,
  epoch: number,
  mint?: Promise<string>,
  cancelRenewal?: () => void
};

const slots: Map<ActiveAccountNumber, IdentitySlot> = new Map();
const logger = getLogger('impulse-identity');
const IdentityExpiryMarginSeconds: number = 60;

function slotFor(account: ActiveAccountNumber): IdentitySlot {
  let slot: IdentitySlot | undefined = slots.get(account);
  if(!slot) {
    slot = {epoch: 0};
    slots.set(account, slot);
  }
  return slot;
}

export function identityEpoch(account: ActiveAccountNumber): number {
  return slotFor(account).epoch;
}

export function discardIdentity(account: ActiveAccountNumber): void {
  const slot: IdentitySlot = slotFor(account);
  resetConnectionInited(account);
  slot.cancelRenewal?.();
  slot.cancelRenewal = undefined;
  slot.value = undefined;
  slot.mint = undefined;
  slot.epoch++;
}

export function refuseIdentity(account: ActiveAccountNumber, epoch: number): void {
  if(identityEpoch(account) !== epoch) {
    return;
  }
  discardIdentity(account);
  resetFleetIdentity(account);
  rekeyUpdateSocket(account);
}

export function identityTokenFor(account: ActiveAccountNumber): Promise<string> {
  const slot: IdentitySlot = slotFor(account);
  if(slot.value && slot.value.exp - Date.now() / 1000 > IdentityExpiryMarginSeconds) {
    return Promise.resolve(slot.value.token);
  }
  if(slot.mint) {
    return slot.mint;
  }
  if(slot.value) {
    refuseIdentity(account, slot.epoch);
    return identityTokenFor(account);
  }
  const epoch: number = slot.epoch;
  const mint: Promise<string> = callPool({
    accountNumber: account,
    method: CONNECTION_IDENTITY_METHOD,
    request: identityRequest('')
  }).then((reply: Uint8Array): string => {
    if(slot.epoch !== epoch) {
      throw new UnauthorizedError('Identity was discarded during mint');
    }
    const value: IdentityToken = identityFromReply(reply);
    storeIdentity(account, value);
    return value.token;
  }).finally((): void => {
    if(slot.mint === mint) {
      slot.mint = undefined;
    }
  });
  slot.mint = mint;
  return mint;
}

function identityRequest(token: string): Uint8Array {
  return toBinary(ConnectionIdentityRequestSchema, create(ConnectionIdentityRequestSchema, {
    identityToken: token,
    apiId: App.id
  }));
}

function identityFromReply(reply: Uint8Array): IdentityToken {
  const token: string = fromBinary(ConnectionIdentityResponseSchema, reply).identityToken;
  const claims = tokenClaims(token);
  if(!claims || typeof claims.sub !== 'string' || !Number.isFinite(claims.orig_iat) || !Number.isFinite(claims.iat)) {
    throw new Error('connectionIdentity returned an invalid identity token');
  }
  return {token, sub: claims.sub, exp: claims.exp, origIat: claims.orig_iat, iat: claims.iat};
}

function storeIdentity(account: ActiveAccountNumber, value: IdentityToken): void {
  const slot: IdentitySlot = slotFor(account);
  slot.cancelRenewal?.();
  slot.value = value;
  slot.cancelRenewal = scheduleTokenRenewal({exp: value.exp, renew: (): Promise<void | boolean> => renewIdentity(account)});
}

async function renewIdentity(account: ActiveAccountNumber): Promise<void | boolean> {
  const slot: IdentitySlot = slotFor(account);
  const current: IdentityToken | undefined = slot.value;
  const epoch: number = slot.epoch;
  if(!current) {
    return;
  }
  try {
    const reply: Uint8Array = await callUpdateSocket({
      accountNumber: account,
      method: CONNECTION_IDENTITY_METHOD,
      request: identityRequest(current.token)
    });
    if(slot.epoch !== epoch || slot.value !== current) {
      return;
    }
    const next: IdentityToken = identityFromReply(reply);
    const same: boolean = next.sub === current.sub && next.origIat === current.origIat && next.origIat !== next.iat;
    if(!same) {
      discardIdentity(account);
    }
    storeIdentity(account, next);
    if(!same) {
      resetFleetIdentity(account);
      rekeyUpdateSocket(account);
    }
  } catch(error: unknown) {
    logger.warn('Identity renewal failed', {account}, error);
    return false;
  }
}
