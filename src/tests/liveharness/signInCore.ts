import {fleetApiError, isApiError, isFleetRpcError} from '@lib/impulse/fleet/fleetError';

import {ephemeralLastName, loginCodeFor, Persona, redrawAfterReuse} from './personas';


/** The auth methods the sign-in drives. */
export type AuthMethod = 'auth.sendCode' | 'auth.signIn' | 'auth.signUp';

/** Any transport that answers an auth method: the client's apiManager or the minimal driver's socket. */
export type AuthInvoke = (method: AuthMethod, params: any) => Promise<any>;

export type AppCredentials = {id: number, hash: string};

/** One pass of sendCode, signIn and signUp: the signed-in authorization, or the answer that spent the number. */
export type SignInPass = {kind: 'signedIn', auth: any} | {kind: 'spent', answer: string};

/** Mirrors the backend's MaxReuseAttempts (tests/ImpulseM.Client/Personas/UserSessionFactory.cs:516). */
export const maxSignInAttempts: number = 64;

const phoneNumberFlood: string = 'PHONE_NUMBER_FLOOD';
const phoneNumberOccupied: string = 'PHONE_NUMBER_OCCUPIED';
const sessionPasswordNeeded: string = 'SESSION_PASSWORD_NEEDED';


/** The canon error type of a rejection, whichever carrier produced it. */
export function answerTypeOf(err: unknown): string | undefined {
  if(isApiError(err)) {
    return err.type;
  }

  if(isFleetRpcError(err)) {
    return fleetApiError(err).type;
  }

  return undefined;
}

/** The number's message quota is spent: an earlier run sent it too many codes. */
export function isSendCodeReuseAnswer(type: string | undefined): boolean {
  return type === phoneNumberFlood;
}

/** The number is already registered to an earlier run's account. */
export function isSignUpReuseAnswer(type: string | undefined): boolean {
  return type === phoneNumberOccupied;
}

/** The number's account was left protected by a cloud password in an earlier run. */
export function isSignInReuseAnswer(type: string | undefined): boolean {
  return type === sessionPasswordNeeded;
}


/**
 * Signs a persona in through the given transport and returns the signed-in authorization. An
 * ephemeral persona must get a new account: a number that already holds one, or whose quota or
 * password an earlier run spent, returns its slot to signed out and is redrawn. Each redraw
 * precedes another attempt, so the final error names only numbers actually tried.
 */
export async function signInWithReuseRetries(
  invoke: AuthInvoke,
  persona: Persona,
  app: AppCredentials,
  signOut: () => Promise<void>
): Promise<any> {
  const mustBeNew: boolean = persona.lastName === ephemeralLastName;
  const attemptLimit: number = mustBeNew ? maxSignInAttempts : 1;
  const tried: string[] = [];

  for(let attempt: number = 1; attempt <= attemptLimit; ++attempt) {
    const phoneTried: string = persona.phone;
    const pass: SignInPass = await signInPass(invoke, persona, app, signOut, mustBeNew);
    if(pass.kind === 'signedIn') {
      return pass.auth;
    }

    tried.push(`${phoneTried}: ${pass.answer}`);
    if(attempt < attemptLimit) {
      redrawAfterReuse(persona);
    }
  }

  throw new Error(
    `no number drawn from canon's reserved test block took a new account in ${attemptLimit} attempts. ` +
    `Tried: ${tried.join('; ')}`
  );
}

async function signInPass(
  invoke: AuthInvoke,
  persona: Persona,
  app: AppCredentials,
  signOut: () => Promise<void>,
  mustBeNew: boolean
): Promise<SignInPass> {
  let sentCode: any;
  try {
    sentCode = await invoke('auth.sendCode', {
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
      'block? The code is derived from the number itself (personas.ts), and a number outside the ' +
      'block would take the real SMS delivery path.'
    );
  }

  let auth: any;
  try {
    auth = await invoke('auth.signIn', {
      phone_number: persona.phone,
      phone_code_hash: sentCode.phone_code_hash,
      phone_code: loginCodeFor(persona)
    });
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(mustBeNew && isSignInReuseAnswer(type)) {
      await signOut();

      return {kind: 'spent', answer: `auth.signIn ${type}`};
    }

    throw err;
  }

  if(auth?._ === 'auth.authorization' && mustBeNew) {
    await signOut();

    return {kind: 'spent', answer: 'auth.signIn auth.authorization'};
  }

  if(auth?._ === 'auth.authorizationSignUpRequired') {
    try {
      auth = await invoke('auth.signUp', {
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
