import {fleetApiError, isApiError, isFleetRpcError} from '@lib/impulse/fleet/fleetError';

import {ephemeralLastName, loginCodeFor, Persona, redrawAfterReuse} from './personas';


/** The auth methods the sign-in drives. */
export type AuthMethod = 'auth.sendCode' | 'auth.signIn' | 'auth.signUp';

/** Any transport that answers an auth method: the client's apiManager or the minimal driver's socket. */
export type AuthInvoke = (method: AuthMethod, params: any) => Promise<any>;

export type AppCredentials = {id: number, hash: string};

/** The outcome of one attempt: a value, or the answer that spent the number. */
type Attempt<T> = {kind: 'done', value: T} | {kind: 'spent', answer: string};

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
 * Finds a reserved number that holds no account and leaves the persona on it. Every attempt that
 * opened a session or a pending password check calls abandon, and the probe never signs up.
 */
export async function findFreshNumber(
  invoke: AuthInvoke,
  persona: Persona,
  app: AppCredentials,
  abandon: () => Promise<void>
): Promise<void> {
  return redrawUntilUsable(
    persona,
    maxSignInAttempts,
    (): Promise<Attempt<void>> => probeAttempt(invoke, persona, app, abandon)
  );
}

/**
 * The single sign-in pass of a headless persona: sendCode, signIn, and signUp on a free number.
 * An ephemeral persona whose signIn finds an account throws instead, because the probe that
 * preceded this pass found the number free and another process must have taken it since.
 */
export async function signInOnce(invoke: AuthInvoke, persona: Persona, app: AppCredentials): Promise<any> {
  const phoneCodeHash: string = await sendCodeHash(invoke, persona, app);
  const answer: any = await invoke('auth.signIn', signInParams(persona, phoneCodeHash));

  if(answer?._ === 'auth.authorization' && persona.lastName === ephemeralLastName) {
    throw new Error(
      `${persona.phone} was probed free, but it already holds an account: another process took ` +
      'the number between the probe and the sign-in'
    );
  }

  if(answer?._ === 'auth.authorizationSignUpRequired') {
    return assertAuthorization(await invoke('auth.signUp', signUpParams(persona, phoneCodeHash)));
  }

  return assertAuthorization(answer);
}

/**
 * Signs a persona in through the given transport and returns the signed-in authorization. An
 * ephemeral persona must get a new account: a number that already holds one, or whose quota or
 * password an earlier run spent, returns its slot to signed out and is redrawn.
 */
export async function signInWithReuseRetries(
  invoke: AuthInvoke,
  persona: Persona,
  app: AppCredentials,
  signOut: () => Promise<void>
): Promise<any> {
  const mustBeNew: boolean = persona.lastName === ephemeralLastName;
  const attemptLimit: number = mustBeNew ? maxSignInAttempts : 1;

  return redrawUntilUsable(
    persona,
    attemptLimit,
    (): Promise<Attempt<any>> => signInAttempt(invoke, persona, app, signOut, mustBeNew)
  );
}


/**
 * The one loop both entry points share: each attempt either yields a value or spends the number,
 * and a spent number is redrawn only when another attempt follows, so the final error lists only
 * the numbers actually tried.
 */
async function redrawUntilUsable<T>(
  persona: Persona,
  attemptLimit: number,
  attempt: () => Promise<Attempt<T>>
): Promise<T> {
  const tried: string[] = [];

  for(let ordinal: number = 1; ordinal <= attemptLimit; ++ordinal) {
    const phoneTried: string = persona.phone;
    const outcome: Attempt<T> = await attempt();
    if(outcome.kind === 'done') {
      return outcome.value;
    }

    tried.push(`${phoneTried}: ${outcome.answer}`);
    if(ordinal < attemptLimit) {
      redrawAfterReuse(persona);
    }
  }

  throw new Error(
    `no number drawn from canon's reserved test block was usable in ${attemptLimit} attempts. ` +
    `Tried: ${tried.join('; ')}`
  );
}

async function probeAttempt(
  invoke: AuthInvoke,
  persona: Persona,
  app: AppCredentials,
  abandon: () => Promise<void>
): Promise<Attempt<void>> {
  let phoneCodeHash: string;
  try {
    phoneCodeHash = await sendCodeHash(invoke, persona, app);
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(isSendCodeReuseAnswer(type)) {
      return {kind: 'spent', answer: `auth.sendCode ${type}`};
    }

    throw err;
  }

  let answer: any;
  try {
    answer = await invoke('auth.signIn', signInParams(persona, phoneCodeHash));
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(isSignInReuseAnswer(type)) {
      await abandon();

      return {kind: 'spent', answer: `auth.signIn ${type}`};
    }

    throw err;
  }

  if(answer?._ === 'auth.authorization') {
    await abandon();

    return {kind: 'spent', answer: 'auth.signIn auth.authorization'};
  }

  if(answer?._ !== 'auth.authorizationSignUpRequired') {
    throw new Error(`auth.signIn answered ${JSON.stringify(answer?._)}, which is neither an authorization nor a sign-up request`);
  }

  await abandon();

  return {kind: 'done', value: undefined};
}

async function signInAttempt(
  invoke: AuthInvoke,
  persona: Persona,
  app: AppCredentials,
  signOut: () => Promise<void>,
  mustBeNew: boolean
): Promise<Attempt<any>> {
  let phoneCodeHash: string;
  try {
    phoneCodeHash = await sendCodeHash(invoke, persona, app);
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(mustBeNew && isSendCodeReuseAnswer(type)) {
      return {kind: 'spent', answer: `auth.sendCode ${type}`};
    }

    throw err;
  }

  let answer: any;
  try {
    answer = await invoke('auth.signIn', signInParams(persona, phoneCodeHash));
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(mustBeNew && isSignInReuseAnswer(type)) {
      await signOut();

      return {kind: 'spent', answer: `auth.signIn ${type}`};
    }

    throw err;
  }

  if(answer?._ === 'auth.authorization' && mustBeNew) {
    await signOut();

    return {kind: 'spent', answer: 'auth.signIn auth.authorization'};
  }

  if(answer?._ !== 'auth.authorizationSignUpRequired') {
    return {kind: 'done', value: assertAuthorization(answer)};
  }

  let signedUp: any;
  try {
    signedUp = await invoke('auth.signUp', signUpParams(persona, phoneCodeHash));
  } catch(err: unknown) {
    const type: string | undefined = answerTypeOf(err);
    if(mustBeNew && isSignUpReuseAnswer(type)) {
      return {kind: 'spent', answer: `auth.signUp ${type}`};
    }

    throw err;
  }

  return {kind: 'done', value: assertAuthorization(signedUp)};
}

async function sendCodeHash(invoke: AuthInvoke, persona: Persona, app: AppCredentials): Promise<string> {
  const sentCode: any = await invoke('auth.sendCode', {
    phone_number: persona.phone,
    api_id: app.id,
    api_hash: app.hash,
    settings: {_: 'codeSettings', pFlags: {}}
  });

  if(!sentCode?.phone_code_hash) {
    throw new Error(
      `auth.sendCode returned no phone_code_hash (got ${JSON.stringify(sentCode?._)}) — ` +
      `is the dev stack up, and is "${persona.phone}" still a number of canon's reserved test ` +
      'block? The code is derived from the number itself (personas.ts), and a number outside the ' +
      'block would take the real SMS delivery path.'
    );
  }

  return sentCode.phone_code_hash;
}

function signInParams(persona: Persona, phoneCodeHash: string): {phone_number: string, phone_code_hash: string, phone_code: string} {
  return {
    phone_number: persona.phone,
    phone_code_hash: phoneCodeHash,
    phone_code: loginCodeFor(persona)
  };
}

function signUpParams(
  persona: Persona,
  phoneCodeHash: string
): {phone_number: string, phone_code_hash: string, first_name: string, last_name: string} {
  return {
    phone_number: persona.phone,
    phone_code_hash: phoneCodeHash,
    first_name: persona.firstName,
    last_name: persona.lastName
  };
}

function assertAuthorization(answer: any): any {
  if(answer?._ !== 'auth.authorization') {
    throw new Error(
      `auth flow did not end in auth.authorization (got ${JSON.stringify(answer?._)}) — ` +
      'the manager stack cannot authenticate headlessly against this gateway'
    );
  }

  return answer;
}
