import type {LiveAccountSlot, LiveStack} from './managerStack';
import {ephemeralLastName, loginCodeFor, Persona, redrawAfterReuse} from './personas';

import {fleetApiError, isApiError, isFleetRpcError} from '@lib/impulse/fleet/fleetError';
import {clearImpulseSession} from '@lib/impulse/session';


/**
 * The minimum surface signInHeadless drives — a whole single-slot LiveStack or one
 * LiveAccountSlot of a bootLiveMultiAccountStack both satisfy it, so a two-account scenario signs
 * each slot in through the same real auth path (each slot's own apiManager, so setUserAuth persists
 * to that slot and brings up that slot's own realtime socket).
 */
export type SignInTarget = Pick<LiveStack, 'managers' | 'helpers'> | LiveAccountSlot;

/** One pass of sendCode, signIn and signUp: the signed-in authorization, or the answer that spent the number. */
export type SignInPass = {kind: 'signedIn', auth: any} | {kind: 'spent', answer: string};

/**
 * How many numbers an ephemeral persona is redrawn through before the sign-in gives up. Each redraw
 * follows an answer that the number was spent by an earlier run, so a long run of them means the
 * block is unusually full, not that the sign-in should keep going.
 */
export const maxSignInAttempts: number = 8;

const floodWaitPrefix: string = 'FLOOD_WAIT_';
const phoneNumberFlood: string = 'PHONE_NUMBER_FLOOD';
const phoneNumberOccupied: string = 'PHONE_NUMBER_OCCUPIED';


/**
 * The canon error type of a rejection, whichever carrier produced it: an ApiError from the client's
 * apiManager, or a raw fleet rejection from the minimal driver's socket.
 */
export function answerTypeOf(err: unknown): string | undefined {
  if(isApiError(err)) {
    return err.type;
  }

  if(isFleetRpcError(err)) {
    return fleetApiError(err).type;
  }

  return undefined;
}

/** A number whose message quota is spent: an earlier run sent it too many codes. */
export function isSendCodeReuseAnswer(type: string | undefined): boolean {
  return type !== undefined && (type.startsWith(floodWaitPrefix) || type === phoneNumberFlood);
}

/** A number another run already registered. */
export function isSignUpReuseAnswer(type: string | undefined): boolean {
  return type === phoneNumberOccupied;
}


/*
 * Headless sign-in through the REAL client auth path — the same invokeApi surface the login
 * page drives, ending in the same apiManager.setUser(...) the fork's own auth flows call
 * (passwordManager.ts:81, appAccountManager.ts:282). Nothing here talks to the backend by any
 * channel the browser client does not use.
 *
 * The dev stack answers auth.sendCode with the scripted code (see ./personas.ts), and its
 * auth service returns auth.authorizationSignUpRequired for an unregistered phone — the
 * canonical Telegram success variant — so an ephemeral persona registers via auth.signUp on
 * first contact and signs in on every later one.
 *
 * An ephemeral persona must get a NEW account: the answer that it already holds one (signIn
 * returning auth.authorization) or that its number is spent (a flood limit, or signUp reporting
 * PHONE_NUMBER_OCCUPIED) sends the sign-in back to a freshly drawn number. The slot of an account
 * that turned out to exist is signed out first, so it does not stay signed in under the old number.
 */
export async function signInHeadless(stack: SignInTarget, persona: Persona): Promise<{userId: UserId}> {
  const mustBeNew: boolean = persona.lastName === ephemeralLastName;
  const attemptLimit: number = mustBeNew ? maxSignInAttempts : 1;
  const tried: string[] = [];

  for(let attempt: number = 1; attempt <= attemptLimit; ++attempt) {
    const phoneTried: string = persona.phone;
    const pass: SignInPass = await signInPass(stack, persona, mustBeNew);
    if(pass.kind === 'signedIn') {
      await stack.managers.apiManager.setUser(pass.auth.user);

      return {userId: pass.auth.user.id};
    }

    tried.push(`${phoneTried}: ${pass.answer}`);
    redrawAfterReuse(persona);
  }

  throw new Error(
    `no number drawn from canon's reserved test block took a new account in ${attemptLimit} attempts. ` +
    `Tried: ${tried.join('; ')}`
  );
}

async function signInPass(stack: SignInTarget, persona: Persona, mustBeNew: boolean): Promise<SignInPass> {
  const apiManager = stack.managers.apiManager;
  const app = stack.helpers.appConfig;

  let sentCode: any;
  try {
    sentCode = await apiManager.invokeApi('auth.sendCode', {
      phone_number: persona.phone,
      api_id: app.id,
      api_hash: app.hash,
      settings: {_: 'codeSettings', pFlags: {}}
    });
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(mustBeNew && isSendCodeReuseAnswer(type)) {
      return {kind: 'spent', answer: `auth.sendCode ${type}`};
    }

    throw err;
  }

  if(!sentCode?.phone_code_hash) {
    throw new Error(
      `auth.sendCode returned no phone_code_hash (got ${JSON.stringify(sentCode?._)}) — ` +
      `is the dev stack up, and is "${persona.phone}" still a number of canon's reserved test ` +
      'block? Nothing is configured for this any more: the code is derived from the number itself ' +
      '(personas.ts), and a number outside the block would take the real SMS delivery path.'
    );
  }

  let auth: any = await apiManager.invokeApi('auth.signIn', {
    phone_number: persona.phone,
    phone_code_hash: sentCode.phone_code_hash,
    phone_code: loginCodeFor(persona)
  });

  if(auth?._ === 'auth.authorization' && mustBeNew) {
    // apiManager.logOut latches for good: the app tears its worker down after it, and this slot signs in again.
    await apiManager.invokeApi('auth.logOut', {});
    await clearImpulseSession(await apiManager.getAccountNumber());

    return {kind: 'spent', answer: 'auth.signIn auth.authorization'};
  }

  if(auth?._ === 'auth.authorizationSignUpRequired') {
    try {
      auth = await apiManager.invokeApi('auth.signUp', {
        phone_number: persona.phone,
        phone_code_hash: sentCode.phone_code_hash,
        first_name: persona.firstName,
        last_name: persona.lastName
      });
    } catch(err: unknown) {
      const type: string | undefined = answerTypeOf(err);
      if(mustBeNew && isSignUpReuseAnswer(type)) {
        return {kind: 'spent', answer: `auth.signUp ${type}`};
      }

      throw err;
    }
  }

  if(auth?._ !== 'auth.authorization') {
    throw new Error(
      `auth flow did not end in auth.authorization (got ${JSON.stringify(auth?._)}) — ` +
      'the manager stack cannot authenticate headlessly against this gateway'
    );
  }

  return {kind: 'signedIn', auth};
}
