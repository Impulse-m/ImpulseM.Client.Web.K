import {createSignal, JSX, onCleanup, onMount} from 'solid-js';

import Button from '@components/buttonTsx';
import PasswordInputField from '@components/passwordInputField';
import PasswordMonkey from '@components/monkeys/password';
import {SimpleConfirmationPopup} from '@components/popups/simpleConfirmation';
import MediaHeader from '@components/mediaHeader';
import {toastNew} from '@components/toast';
import {wrapFormattedDuration} from '@components/wrappers/wrapDuration';
import anchorCallback from '@helpers/dom/anchorCallback';
import cancelEvent from '@helpers/dom/cancelEvent';
import focusWhenConnected from '@helpers/dom/focusWhenConnected';
import htmlToSpan from '@helpers/dom/htmlToSpan';
import replaceContent from '@helpers/dom/replaceContent';
import formatDuration from '@helpers/formatDuration';
import mediaSizes from '@helpers/mediaSizes';
import {AccountPassword} from '@layer';
import {LangPackKey, i18n} from '@lib/langPack';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';

import AuthCard from '@/pages/AuthCard';
import {CardSpec, useAuthFlow} from '@/pages/authFlow';
import styles from '@/pages/authFlow.module.scss';

if(import.meta.hot) import.meta.hot.accept();

type Spec = Extract<CardSpec, {name: 'password'}>;

const TEST = false;

/**
 * Card variant of `pagePassword`. Single password input over a `PasswordMonkey`
 * animation, with a "forgot password" link that leads to `emailRecover` (or to
 * full account reset if recovery isn't available).
 */
export default function PasswordCard(_props: {spec: Spec}) {
  const {managers, navigate, toIm} = useAuthFlow();

  let monkey: PasswordMonkey | undefined;
  const monkeyContainer = document.createElement('div');
  const monkeySize = mediaSizes.isMobile ? 100 : 130;

  let getStateInterval: number | undefined;
  let state: AccountPassword;
  let resetLoading = false;

  // Whether THIS card's own login attempt is still the one that gets to act. Flipped false the
  // instant its outcome is decided — success (toIm), abandonment (the pending challenge expired
  // or was rejected), or unmount — and checked by every async callback before it does anything
  // observable (navigate/setUser/toIm-equivalent state changes). Needed because unmount alone
  // does not bound this card's lifetime the way it looks like it should: toIm() (AuthCardsHost.tsx)
  // does not unmount the auth flow, it schedules disposeActiveAuthFlow() a full second later
  // (bootstrapIm.ts), so this card and its background poll stay mounted and reactive for that
  // whole window — long enough for an already-in-flight poll response, issued before success,
  // to arrive afterward and (without this guard) steer the now-authenticated UI back to sign-in
  // (#675 revision3, item C).
  let flowActive = true;

  /* ---------- state ---------- */

  const [submitting, setSubmitting] = createSignal(false);
  const [nextKey, setNextKey] = createSignal<LangPackKey>('Login.Next');

  /* ---------- input ---------- */

  const passwordInputField = new PasswordInputField({
    label: 'LoginPassword',
    name: 'password'
  });
  const passwordInput = passwordInputField.input as HTMLInputElement;

  /* ---------- forgot link ---------- */

  const resetLink = i18n('ForgotPassword', [
    anchorCallback(() => {
      if(resetLoading) return;
      resetLoading = true;

      managers.passwordManager.requestRecovery().then((res) => {
        navigate({name: 'emailRecover', payload: {email_pattern: res.email_pattern}});
      }).catch(async(err: ApiError) => {
        if(err.type === 'PASSWORD_RECOVERY_NA') {
          await SimpleConfirmationPopup.show({
            titleLangKey: 'Login.ResetPassword.Title',
            descriptionLangKey: 'Login.ResetPassword.NoEmailText',
            button: {
              langKey: 'Login.ResetPassword.ResetAccount',
              isDanger: true
            }
          });

          await SimpleConfirmationPopup.show({
            titleLangKey: 'Login.ResetAccount.Title',
            descriptionLangKey: 'Login.ResetAccount.Text',
            button: {
              langKey: 'Login.ResetPassword.ResetAccount',
              isDanger: true
            }
          });

          await managers.appAccountManager.deleteAccount('Forgot password').then(() => {
            navigate({name: 'signIn'});
          }).catch((err: ApiError) => {
            if(err.type === '2FA_RECENT_CONFIRM') {
              SimpleConfirmationPopup.show({
                titleLangKey: 'Login.ResetAccountFail.Title',
                descriptionLangKey: 'Login.ResetAccountFail.TextCancelled',
                button: {langKey: 'OK'}
              });
            } else if(err.type.startsWith('2FA_CONFIRM_WAIT_')) {
              const waitTime = +err.type.replace('2FA_CONFIRM_WAIT_', '');
              SimpleConfirmationPopup.show({
                titleLangKey: 'Login.ResetAccountFail.Title',
                descriptionLangKey: 'Login.ResetAccountFail.TextWait',
                descriptionArgs: [wrapFormattedDuration(formatDuration(waitTime))],
                button: {langKey: 'OK'}
              });
            } else {
              console.error(err);
              toastNew({langPackKey: 'Error.AnError'});
            }
          });
          return;
        }

        toastNew({langPackKey: 'Error.AnError'});
      }).finally(() => {
        resetLoading = false;
      });
    })
  ]);
  resetLink.classList.add(styles.forgotLink);

  /* ---------- pending-challenge-gone handling (shared by the poll and by submit) ---------- */

  // AUTH_KEY_UNREGISTERED: the pending token expired (5-minute TTL, JwtTokenService.cs:164) or
  // was never presented at all. AUTH_TOKEN_INVALID: the specific catalog code for an
  // already-revoked/consumed pending token (JwtValidationInterceptor.cs:286-295, missingCap
  // "pending-revoked"). Either way there is no session yet and nothing left on this card that can
  // ever succeed against it — the caller must leave for the start of sign-in, not show a
  // password-specific error for a credential problem that was never about the password (#675).
  function isPendingChallengeGone(err: any): boolean {
    return err?.type === 'AUTH_KEY_UNREGISTERED' || err?.type === 'AUTH_TOKEN_INVALID';
  }

  /** Stops the background poll without deciding the flow either way — used on every exit. */
  function stopPolling(): void {
    if(getStateInterval) {
      clearInterval(getStateInterval);
      getStateInterval = undefined;
    }
  }

  function abandonToSignIn(): void {
    flowActive = false;
    stopPolling();
    navigate({name: 'signIn'});
  }

  /**
   * The raw fetch, shared by the background poll and by onSubmit's own fresh-challenge fetch —
   * each wraps it with error handling suited to what depends on it (poll: swallow and retry next
   * tick; submit: propagate so check() never runs against stale/undefined state). ignoreErrors:
   * this card can be reached with only a pending 2FA bearer, not a session (#675) — a transient or
   * expired getPassword here must never read to apiManager's blanket 401 policy as "this account's
   * session was revoked" and log the whole slot out.
   */
  function fetchFreshState(): Promise<AccountPassword> {
    return managers.passwordManager.getState({ignoreErrors: true});
  }

  function applyState(freshState: AccountPassword): void {
    state = freshState;
    if(freshState.hint) {
      replaceContent(passwordInputField.label, htmlToSpan(wrapEmojiText(freshState.hint)));
    } else {
      passwordInputField.setLabel();
    }
  }

  /* ---------- state polling (session relevance) ---------- */

  function getState() {
    if(!getStateInterval) {
      getStateInterval = window.setInterval(getState, 10e3);
    }

    return !TEST && fetchFreshState().then((freshState) => {
      // This exact tick's request may have been issued before this card's own outcome was
      // already decided elsewhere (success, abandonment) — toIm() does not unmount the card for
      // a full second (bootstrapIm.ts), so a poll tick from just before submit succeeded can
      // still resolve deep into that window. Applying its (now-irrelevant) hint text would be
      // harmless by itself, but the identical race on the catch branch below is not, so both
      // branches check the same flag for the same reason.
      if(!flowActive) return;
      applyState(freshState);
    }).catch((err: any) => {
      if(!flowActive) {
        // This card's outcome is already decided; a stale poll rejection — however it reads —
        // must not act on it (#675 revision3, item C: no callback from an old form may steer a
        // later flow, and success/abandonment already ended this one).
        return;
      }

      if(isPendingChallengeGone(err)) {
        // There is nothing left on this card to poll for any more.
        abandonToSignIn();
        return;
      }

      // Any other failure (network blip, etc.) is not this poll's problem to surface loudly —
      // the next tick simply tries again. onSubmit below does its own fresh fetch and handles
      // its own failures explicitly; it does not depend on this catch's behaviour.
    });
  }

  /* ---------- submit ---------- */

  async function onSubmit(e?: Event) {
    if(e) cancelEvent(e);

    // Defensive: the button/Enter key live on this card's own DOM, so an already-decided flow
    // realistically can't still trigger this — but costs nothing to state explicitly alongside
    // the other guards below rather than rely on that alone.
    if(!flowActive) return;

    if(!passwordInput.value.length) {
      passwordInput.classList.add('error');
      return;
    }

    setSubmitting(true);
    passwordInput.disabled = true;
    setNextKey('PleaseWait');

    const value = passwordInput.value;
    passwordInputField.setValueSilently('' + Math.random()); // prevent saving suggestion
    passwordInputField.setValueSilently(value);

    // A fresh account.getPassword challenge immediately before EVERY submit — not the possibly
    // stale state from mount or the last 10s poll tick, which is only a hint/label refresh. The
    // SRP challenge is single-use (consumed server-side on every auth.checkPassword call, success
    // or failure, SrpChallengeStore.cs GETDEL) — reusing an already-consumed one answers
    // SRP_ID_INVALID, indistinguishable in this card from a wrong password otherwise (#675).
    let freshState: AccountPassword;
    try {
      freshState = await fetchFreshState();
      if(!flowActive) return; // decided (e.g. by a concurrent poll tick) while this fetch was in flight
      applyState(freshState);
    } catch(err: any) {
      if(!flowActive) return;

      if(isPendingChallengeGone(err)) {
        abandonToSignIn();
        return;
      }

      // A genuine transport/server failure fetching THIS attempt's own challenge — never call
      // check() against stale/undefined state for it, and never dress it up as a wrong password:
      // the two are different problems with different fixes (retry vs. type the password again).
      setSubmitting(false);
      passwordInput.disabled = false;
      toastNew({langPackKey: 'Error.AnError'});
      return;
    }

    try {
      const response = await managers.passwordManager.check(value, freshState, {ignoreErrors: true});
      if(!flowActive) return; // decided while checkPassword was in flight — do not act on its outcome

      switch(response._) {
        case 'auth.authorization':
          // Decides the flow HERE, before toIm() — not only in onCleanup — because toIm() does
          // not unmount this card for a full second (bootstrapIm.ts's own setTimeout), during
          // which an already-in-flight background poll response could otherwise still fire
          // abandonToSignIn() and yank the UI back to sign-in after a genuinely successful login
          // (#675 revision3, item C). Polling is stopped in the same step so no further tick can
          // even start during that window.
          flowActive = false;
          stopPolling();
          toIm();
          monkey?.remove();
          break;
        default:
          setSubmitting(false);
          passwordInput.disabled = false;
          setNextKey(response._ as LangPackKey);
          break;
      }
    } catch(err: any) {
      if(!flowActive) return;

      if(isPendingChallengeGone(err)) {
        abandonToSignIn();
        return;
      }

      setSubmitting(false);
      passwordInput.disabled = false;
      passwordInputField.input.classList.add('error');

      switch(err.type) {
        default:
          setNextKey('PASSWORD_HASH_INVALID');
          passwordInput.select();
          break;
      }
    }
  }

  passwordInput.addEventListener('keypress', function(this, e) {
    this.classList.remove('error');
    setNextKey('Login.Next');

    if(e.key === 'Enter') {
      return onSubmit();
    }
  });

  /* ---------- lifecycle ---------- */

  let cancelFocus: (() => void) | undefined;
  onMount(() => {
    managers.appStateManager.pushToState('authState', {_: 'authStatePassword'});

    monkey = new PasswordMonkey(passwordInputField, monkeySize);
    monkeyContainer.append(monkey.container);
    monkey.load();

    getState();

    cancelFocus = focusWhenConnected(passwordInput);
  });

  onCleanup(() => {
    flowActive = false;
    stopPolling();
    cancelFocus?.();
    monkey?.remove();
  });

  return (
    <AuthCard
      class={styles.pagePassword}
      header={
        <MediaHeader>
          <MediaHeader.Sticker element={monkeyContainer} size={monkeySize}/>
          <MediaHeader.Title>{i18n('Login.Password.Title')}</MediaHeader.Title>
          <MediaHeader.Subtitle>{i18n('Login.Password.Subtitle')}</MediaHeader.Subtitle>
        </MediaHeader>
      }
    >
      {passwordInputField.container}
      {resetLink}
      <Button
        class="btn-primary btn-color-primary"
        disabled={submitting()}
        onClick={onSubmit}
      >
        {i18n(nextKey())}
        {submitting() && (
          <svg xmlns="http://www.w3.org/2000/svg" class="preloader-circular" viewBox="25 25 50 50">
            <circle class="preloader-path" cx="50" cy="50" r="20" fill="none" stroke-miterlimit="10"/>
          </svg>
        )}
      </Button>
    </AuthCard>
  );
}
