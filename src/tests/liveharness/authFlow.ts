import type {LiveAccountSlot, LiveStack} from './managerStack';
import {liveLane} from './liveGate';
import {ephemeralLastName, Persona} from './personas';
import {claimFreshNumber} from './rpcDriver';
import {AuthMethod, signInOnce} from './signInCore';


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
 *
 * The stack never signs in to an account that is not its persona's own new one: an ephemeral
 * persona's number is probed over a throwaway socket first, and only then signed in on this stack.
 */
export async function signInHeadless(stack: SignInTarget, persona: Persona): Promise<{userId: UserId}> {
  const apiManager = stack.managers.apiManager;
  if(persona.lastName === ephemeralLastName) {
    // Every reserved number allows 3 codes an hour (backend src/ImpulseM.Sms.Common/Configuration/SmsAdmissionOptions.cs:42), and the probe plus the sign-in spend 2.
    await claimFreshNumber(liveLane.gatewayOrigin, persona);
  }

  const auth: any = await signInOnce(
    (method: AuthMethod, params: any): Promise<any> => apiManager.invokeApi(method, params),
    persona,
    stack.helpers.appConfig
  );

  await apiManager.setUser(auth.user);

  return {userId: auth.user.id};
}
