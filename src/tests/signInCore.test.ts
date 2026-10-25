import {describe, expect, it, vi} from 'vitest';

import {ephemeralPersona, Persona} from './liveharness/personas';
import {
  answerTypeOf,
  AppCredentials,
  AuthInvoke,
  isSendCodeReuseAnswer,
  isSignInReuseAnswer,
  isSignUpReuseAnswer,
  maxSignInAttempts,
  signInWithReuseRetries
} from './liveharness/signInCore';


const app: AppCredentials = {id: 1, hash: 'hash'};
const reservedNumberShape: RegExp = /\+99966\d{5}/g;

function apiError(type: string): {type: string, code: number} {
  return {type, code: 400};
}

describe('reuse answers that spend a number', () => {
  it('treats PHONE_NUMBER_FLOOD on sendCode as spent', () => {
    expect(isSendCodeReuseAnswer('PHONE_NUMBER_FLOOD')).toBe(true);
  });

  it('does not treat FLOOD_WAIT_30 on sendCode as spent: it is rethrown', () => {
    expect(isSendCodeReuseAnswer('FLOOD_WAIT_30')).toBe(false);
  });

  it('treats PHONE_NUMBER_OCCUPIED on signUp as spent', () => {
    expect(isSignUpReuseAnswer('PHONE_NUMBER_OCCUPIED')).toBe(true);
  });

  it('treats SESSION_PASSWORD_NEEDED on signIn as spent', () => {
    expect(isSignInReuseAnswer('SESSION_PASSWORD_NEEDED')).toBe(true);
  });

  it('does not treat any other answer as spent', () => {
    expect(isSendCodeReuseAnswer('PHONE_CODE_EMPTY')).toBe(false);
    expect(isSignUpReuseAnswer('PHONE_NUMBER_FLOOD')).toBe(false);
    expect(isSignInReuseAnswer('PASSWORD_HASH_INVALID')).toBe(false);
  });

  it('reads the canon type of an ApiError and nothing from a plain Error', () => {
    expect(answerTypeOf(apiError('FLOOD_WAIT_30'))).toBe('FLOOD_WAIT_30');
    expect(answerTypeOf(new Error('transport'))).toBeUndefined();
  });
});

describe('the sign-in loop against a stub transport', () => {
  it('returns the slot to signed out on an existing account, redraws, and signs up on the next number', async() => {
    const persona: Persona = ephemeralPersona('loop-redraw');
    const existingPhone: string = persona.phone;
    const signOut: () => Promise<void> = vi.fn(async(): Promise<void> => undefined);
    const signedUpPhones: string[] = [];
    const invoke: AuthInvoke = async(method, params): Promise<any> => {
      if(method === 'auth.sendCode') {
        return {phone_code_hash: 'hash'};
      }

      if(method === 'auth.signIn') {
        return params.phone_number === existingPhone
          ? {_: 'auth.authorization', user: {id: 1}}
          : {_: 'auth.authorizationSignUpRequired'};
      }

      signedUpPhones.push(params.phone_number);

      return {_: 'auth.authorization', user: {id: 2}};
    };

    const auth: any = await signInWithReuseRetries(invoke, persona, app, signOut);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(persona.phone).not.toBe(existingPhone);
    expect(signedUpPhones).toEqual([persona.phone]);
    expect(auth.user.id).toBe(2);
  });

  it('returns the slot to signed out when a cloud password marks the number spent, then redraws', async() => {
    const persona: Persona = ephemeralPersona('loop-password');
    const protectedPhone: string = persona.phone;
    const signOut: () => Promise<void> = vi.fn(async(): Promise<void> => undefined);
    const invoke: AuthInvoke = async(method, params): Promise<any> => {
      if(method === 'auth.sendCode') {
        return {phone_code_hash: 'hash'};
      }

      if(method === 'auth.signIn' && params.phone_number === protectedPhone) {
        throw apiError('SESSION_PASSWORD_NEEDED');
      }

      if(method === 'auth.signIn') {
        return {_: 'auth.authorizationSignUpRequired'};
      }

      return {_: 'auth.authorization', user: {id: 3}};
    };

    const auth: any = await signInWithReuseRetries(invoke, persona, app, signOut);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(persona.phone).not.toBe(protectedPhone);
    expect(auth.user.id).toBe(3);
  });

  it('throws after 64 spent numbers, naming 64 numbers that were each tried', async() => {
    const persona: Persona = ephemeralPersona('loop-exhaust');
    const signOut: () => Promise<void> = vi.fn(async(): Promise<void> => undefined);
    const sentPhones: string[] = [];
    const invoke: AuthInvoke = async(method, params): Promise<any> => {
      if(method === 'auth.sendCode') {
        sentPhones.push(params.phone_number);

        return {phone_code_hash: 'hash'};
      }

      return {_: 'auth.authorization', user: {id: 4}};
    };

    const error: unknown = await signInWithReuseRetries(invoke, persona, app, signOut).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    const named: string[] = (error as Error).message.match(reservedNumberShape) ?? [];
    expect(maxSignInAttempts).toBe(64);
    expect(named).toHaveLength(64);
    expect(new Set(named)).toEqual(new Set(sentPhones));
    expect(sentPhones).toHaveLength(64);
    expect(signOut).toHaveBeenCalledTimes(64);
  });

  it('rethrows a non-reuse error on the first attempt unchanged, with no redraw and no sign-out', async() => {
    const persona: Persona = ephemeralPersona('loop-other-error');
    const before: string = persona.phone;
    const rejection: unknown = apiError('PHONE_CODE_EMPTY');
    const signOut: () => Promise<void> = vi.fn(async(): Promise<void> => undefined);
    const invoke: AuthInvoke = async(): Promise<any> => {
      throw rejection;
    };

    const error: unknown = await signInWithReuseRetries(invoke, persona, app, signOut).catch((err: unknown) => err);

    expect(error).toBe(rejection);
    expect(persona.phone).toBe(before);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('rethrows FLOOD_WAIT on sendCode unchanged, without redrawing the number', async() => {
    const persona: Persona = ephemeralPersona('loop-flood-wait');
    const before: string = persona.phone;
    const rejection: unknown = apiError('FLOOD_WAIT_30');
    const signOut: () => Promise<void> = vi.fn(async(): Promise<void> => undefined);
    const invoke: AuthInvoke = async(): Promise<any> => {
      throw rejection;
    };

    const error: unknown = await signInWithReuseRetries(invoke, persona, app, signOut).catch((err: unknown) => err);

    expect(error).toBe(rejection);
    expect(persona.phone).toBe(before);
  });
});
