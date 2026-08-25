import {AppManager} from '@appManagers/manager';
import {HelpCountriesList} from '@layer';
import App from '@config/app';
import {logger} from '@lib/logger';

// Every langpack request and its answer, because "languages do not work" could not be told apart
// from the outside: the server recorded four successful calls and no refusal, and nothing said
// which language was asked for or how many strings came back. The server logs the same three
// numbers now; these lines are the client half of the same pair, so the two can be compared
// directly instead of inferred.
let langLogInstance: ReturnType<typeof logger>;
// Built on first use: constructing a logger while this module evaluates runs inside an
// import cycle and fails module init, which the browser reports only as a dynamic import
// of some unrelated module failing to load.
const langLog = (...args: any[]) => (langLogInstance ||= logger('LANGPACK'))(...args);

export class AppLangPackManager extends AppManager {
  protected after() {
    this.apiUpdatesManager.addMultipleEventsListeners({
      updateLangPack: (update) => {
        this.rootScope.dispatchEvent('langpack_update', update);
      },
      updateLangPackTooLong: (update) => {
        this.rootScope.dispatchEvent('langpack_update_too_long', update);
      }
    });
  }

  public getLangPack(langCode: string, langPack: string, ignoreCache?: boolean) {
    langLog('getLangPack ->', {langCode, langPack, ignoreCache: !!ignoreCache});
    return this.apiManager.invokeApiCacheable('langpack.getLangPack', {
      lang_code: langCode,
      lang_pack: langPack
    }, {override: ignoreCache}).then((difference) => {
      langLog('getLangPack <-', {
        langCode: difference?.lang_code,
        version: difference?.version,
        strings: difference?.strings?.length
      });
      return difference;
    }, (error) => {
      (langLogInstance ||= logger('LANGPACK')).error('getLangPack failed', {langCode, langPack}, error);
      throw error;
    });
  }

  public getCountriesList(langCode: string, ignoreCache?: boolean) {
    return this.apiManager.invokeApiCacheable('help.getCountriesList', {
      lang_code: langCode,
      hash: 0
    }, {override: ignoreCache}) as Promise<HelpCountriesList.helpCountriesList>;
  }

  public getStrings(langCode: string, strings: string[]) {
    langLog('getStrings ->', {langCode, langPack: App.langPack, keys: strings.length});
    return this.apiManager.invokeApi('langpack.getStrings', {
      lang_pack: App.langPack,
      lang_code: langCode,
      keys: strings
    }).then((answer) => {
      langLog('getStrings <-', {langCode, returned: answer?.length});
      return answer;
    }, (error) => {
      (langLogInstance ||= logger('LANGPACK')).error('getStrings failed', {langCode, langPack: App.langPack}, error);
      throw error;
    });
  }

  public getDifference(langCode: string, fromVersion: number) {
    langLog('getDifference ->', {langCode, langPack: App.langPack, fromVersion});
    return this.apiManager.invokeApi('langpack.getDifference', {
      lang_code: langCode,
      from_version: fromVersion,
      lang_pack: App.langPack
    }).then((difference) => {
      langLog('getDifference <-', {
        langCode: difference?.lang_code,
        version: difference?.version,
        strings: difference?.strings?.length
      });
      return difference;
    }, (error) => {
      (langLogInstance ||= logger('LANGPACK')).error('getDifference failed', {langCode, langPack: App.langPack, fromVersion}, error);
      throw error;
    });
  }
}
