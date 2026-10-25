import type {LiveAccountSlot, LiveStack} from './managerStack';
import {AuthMethod, signInWithReuseRetries} from './signInCore';
import {Persona} from './personas';

import {ActiveAccountNumber} from '@lib/accounts/types';
import {getGrpcSessionToken} from '@lib/impulse/grpc/credentials';
import {clearImpulseSession} from '@lib/impulse/session';


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
  const auth: any = await signInWithReuseRetries(
    (method: AuthMethod, params: any): Promise<any> => apiManager.invokeApi(method, params),
    persona,
    stack.helpers.appConfig,
    async(): Promise<void> => {
      // apiManager.logOut latches for good: the app tears its worker down after it, and this slot signs in again.
      const accountNumber: ActiveAccountNumber = await apiManager.getAccountNumber();
      if(getGrpcSessionToken(accountNumber) !== undefined) {
        await apiManager.invokeApi('auth.logOut', {});
      }
      await clearImpulseSession(accountNumber);
    }
  );

  await apiManager.setUser(auth.user);

  return {userId: auth.user.id};
}
