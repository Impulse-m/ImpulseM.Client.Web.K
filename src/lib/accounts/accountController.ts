import {MOUNT_CLASS_TO} from '@config/debug';
import App from '@config/app';
import tsNow from '@helpers/tsNow';
import type {TrueDcId} from '@types';

import sessionStorage from '@lib/sessionStorage';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import StaticUtilityClass from '@lib/staticUtilityClass';

import {AccountSessionData, ActiveAccountNumber} from '@lib/accounts/types';
import {MAX_ACCOUNTS} from '@lib/accounts/constants';
import bytesToHex from '@helpers/bytes/bytesToHex';
import randomize from '@helpers/array/randomize';

export class AccountController extends StaticUtilityClass {
  static async getTotalAccounts() {
    const promises = ([1, 2, 3, 4] as const).map((accountNumber) => this.get(accountNumber));
    const allAccountsData = await Promise.all(promises);
    return allAccountsData.filter((accountData) => !!accountData.userId).length;
  }

  static async getUnencryptedTotalAccounts() {
    return sessionStorage.get('number_of_accounts');
  }

  static async getUserIds() {
    const promises = ([1, 2, 3, 4] as const).map((accountNumber) => this.get(accountNumber));
    const allAccountsData = await Promise.all(promises);
    return allAccountsData.map((accountData) => accountData.userId).filter(Boolean);
  }

  static async get(accountNumber: ActiveAccountNumber, updating?: boolean) {
    const data = await sessionStorage.get(`account${accountNumber}`) || {} as AccountSessionData;

    if(!updating && this.fillMissingData(data)) {
      await this.update(accountNumber, data);
    }

    return data;
  }

  static fillMissingData(data: AccountSessionData) {
    return [
      this.fillFingerprint(data),
      this.fillPushKey(data)
    ].some(Boolean);
  }

  static fillFingerprint(data: AccountSessionData) {
    if(!data.auth_key_fingerprint) {
      const authKey = data[`dc${App.baseDcId}_auth_key`];
      if(!authKey) {
        return false;
      }

      data.auth_key_fingerprint = authKey ? authKey.slice(0, 8) : undefined;
      return true;
    }

    return false;
  }

  static fillPushKey(data: AccountSessionData) {
    if(!data.push_key && data.userId) {
      data.push_key = bytesToHex(randomize(new Uint8Array(256)));
      return true;
    }

    return false;
  }

  /**
   * `applyUpdate` reads the whole record, merges, then writes it back. Two
   * concurrent callers therefore both read the pre-update snapshot, and the later
   * write silently drops whatever the earlier one added. Sign-in does exactly
   * that: the session token and the user id are written from two different places
   * in the same tick, and the user id landed last -- so a reload found an account
   * that was signed in but had no token, and asked for the code again.
   *
   * Serialising per account makes each read see the previous write. `get` is only
   * re-entered here with `updating`, which does not call back into `update`, so
   * the chain cannot wait on itself.
   */
  private static updateQueues = new Map<ActiveAccountNumber, Promise<AccountSessionData>>();

  static update(accountNumber: ActiveAccountNumber, data: Partial<AccountSessionData>, overrideAll = false) {
    const previous = this.updateQueues.get(accountNumber);
    const next = (previous ? previous.catch(() => {}) : Promise.resolve())
    .then(() => this.applyUpdate(accountNumber, data, overrideAll));

    this.updateQueues.set(accountNumber, next);
    next.catch(() => {}).then(() => {
      if(this.updateQueues.get(accountNumber) === next) {
        this.updateQueues.delete(accountNumber);
      }
    });

    return next;
  }

  private static async applyUpdate(accountNumber: ActiveAccountNumber, data: Partial<AccountSessionData>, overrideAll = false) {
    const prevData = await this.get(accountNumber, true);

    const updatedData = {
      ...(overrideAll ? {} : prevData),
      ...data
    };

    this.fillMissingData(updatedData);

    await sessionStorage.set({
      [`account${accountNumber}`]: updatedData
    });

    if(accountNumber === 1) {
      await this.updateStorageForLegacy(updatedData);
    }

    (async() => {
      sessionStorage.set({
        number_of_accounts: await this.getTotalAccounts()
      });
    })();

    return updatedData;
  }

  /**
   * Shifts 4 -> 3, 3 -> 2 ... depending on which account you need to delete
   * @param upTo Account to delete basically
   */
  static async shiftAccounts(upTo: ActiveAccountNumber) {
    for(let i = upTo; i <= MAX_ACCOUNTS; i++) {
      await sessionStorage.delete(`account${i as ActiveAccountNumber}`);
      if(i < MAX_ACCOUNTS) {
        const toMove = await this.get((i + 1) as ActiveAccountNumber);
        toMove.userId && (await this.update(i as ActiveAccountNumber, toMove, true));
      }
    }
  }

  /**
   * Use `null` when needing to remove the values (e.g. when enabling passcode)
   */
  static async updateStorageForLegacy(accountData: Partial<AccountSessionData> | null) {
    if(accountData !== null && await DeferredIsUsingPasscode.isUsingPasscode()) return; // We can't expose keys if there's a passcode set

    if(accountData === null) accountData = {};

    const obj: Parameters<typeof sessionStorage['set']>[0] = {};
    const toClear: (keyof typeof obj)[] = [];

    const set = <T extends keyof typeof obj>(key: T, value: typeof obj[T]) => {
      if(value) obj[key] = value;
      else toClear.push(key);
    };

    for(let i = 1; i <= 5; i++) {
      const authKeyKey = `dc${i as TrueDcId}_auth_key` as const;
      const serverSaltKey = `dc${i as TrueDcId}_server_salt` as const;

      set(authKeyKey, accountData[authKeyKey]);
      set(serverSaltKey, accountData[serverSaltKey]);
    }

    accountData['auth_key_fingerprint'] && set('auth_key_fingerprint', accountData['auth_key_fingerprint']);
    set('user_auth', accountData['userId'] && {
      date: tsNow(true),
      id: accountData.userId,
      dcID: accountData.dcId || 0
    });
    set('dc', accountData.dcId);

    await Promise.all([
      sessionStorage.set(obj),
      Promise.all(toClear.map((key) => sessionStorage.delete(key)))
    ]);
  }
}

MOUNT_CLASS_TO.AccountController = AccountController;

export default AccountController;
