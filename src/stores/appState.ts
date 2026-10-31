import {createRoot} from 'solid-js';
import {createStore, reconcile, SetStoreFunction, unwrap} from 'solid-js/store';
import {State} from '@config/state';
import rootScope from '@lib/rootScope';
import useStars, {hasTonTransactions} from '@stores/stars';

const [appState, _setAppState] = createRoot(() => createStore<State>({} as any));

const setAppState: SetStoreFunction<State, Promise<void>> = (...args: any[]) => {
  const key = args[0];
  // @ts-ignore
  _setAppState(...args);
  // @ts-ignore
  return rootScope.managers.appStateManager.setByKey(key, unwrap(appState[key]));
};

const setAppStateSilent = (key: any, value?: any) => {
  if(typeof(key) === 'object') {
    _setAppState(key);
    return;
  }

  _setAppState(key, reconcile(value));
};

const useAppState = () => [appState, setAppState] as const;

const useAppConfig = () => appState.appConfig;

const useIsFrozen = () => !!useAppConfig().freeze_since_date;

const EMPTY_APP_CONFIG: Partial<MTAppConfig> = {};

const appConfigOrEmpty = (): Partial<MTAppConfig> => useAppConfig() ?? EMPTY_APP_CONFIG;

const starsUiBlocked = () => appConfigOrEmpty().stars_purchase_blocked ?? true;

const giftsBlocked = () => {
  const appConfig = appConfigOrEmpty();
  return (appConfig.stargifts_blocked ?? true) || !(appConfig.stars_gifts_enabled ?? true);
};

const canPostStories = () => {
  const storiesPosting = appConfigOrEmpty().stories_posting ?? 'enabled';
  return storiesPosting === 'enabled' || (storiesPosting === 'premium' && rootScope.premium);
};

const ownStoriesShown = (hasOwnStories: boolean) => hasOwnStories || canPostStories();

const walletShown = () => hasTonTransactions() || String(useStars(true)()) !== '0';

export {
  appState,
  useAppState,
  setAppState,
  setAppStateSilent,
  useAppConfig,
  useIsFrozen,
  starsUiBlocked,
  giftsBlocked,
  canPostStories,
  ownStoriesShown,
  walletShown
};
