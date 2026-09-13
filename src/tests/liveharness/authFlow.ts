import type {LiveAccountSlot, LiveStack} from './managerStack';
import {loginCodeFor, Persona} from './personas';


/**
 * The minimum surface signInHeadless drives — a whole single-slot LiveStack or one
 * LiveAccountSlot of a bootLiveMultiAccountStack both satisfy it, so a two-account scenario signs
 * each slot in through the same real auth path (each slot's own apiManager, so setUserAuth persists
 * to that slot and brings up that slot's own realtime socket).
 */
export type SignInTarget = Pick<LiveStack, 'managers' | 'helpers'> | LiveAccountSlot;


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
 */
export async function signInHeadless(stack: SignInTarget, persona: Persona): Promise<{userId: UserId}> {
  const apiManager = stack.managers.apiManager;
  const app = stack.helpers.appConfig;

  const sentCode: any = await apiManager.invokeApi('auth.sendCode', {
    phone_number: persona.phone,
    api_id: app.id,
    api_hash: app.hash,
    settings: {_: 'codeSettings', pFlags: {}}
  });

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

  if(auth?._ === 'auth.authorizationSignUpRequired') {
    auth = await apiManager.invokeApi('auth.signUp', {
      phone_number: persona.phone,
      phone_code_hash: sentCode.phone_code_hash,
      first_name: persona.firstName,
      last_name: persona.lastName
    });
  }

  if(auth?._ !== 'auth.authorization') {
    throw new Error(
      `auth flow did not end in auth.authorization (got ${JSON.stringify(auth?._)}) — ` +
      'the manager stack cannot authenticate headlessly against this gateway'
    );
  }

  await apiManager.setUser(auth.user);

  return {userId: auth.user.id};
}
