/*
 * Originally from:
 * https://github.com/zhukov/webogram
 * Copyright (C) 2014 Igor Zhukov <igor.beatle@gmail.com>
 * https://github.com/zhukov/webogram/blob/master/LICENSE
 */

import MTPNetworker from '@lib/mtproto/networker';
import App from '@config/app';
import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import {AppManager} from '@appManagers/manager';
import AccountController from '@lib/accounts/accountController';
import bytesToHex from '@helpers/bytes/bytesToHex';
import {getEnvironment} from '@environment/utils';
import {setConnectionDeclaration} from '@lib/impulse/grpc/transport';

const TimezoneRoundingSeconds = 900;

export class NetworkerFactory extends AppManager {
  private networkers: MTPNetworker[] = [];
  public language = navigator.language || App.langPackCode;
  private customDeviceModel = '';
  public updatesProcessor: (obj: any) => void = null;
  // public onConnectionStatusChange: (status: ConnectionStatusChange) => void = null;
  public akStopped = false;

  constructor() {
    super();
    this.name = 'NET-FACTORY';
  }

  protected after() {
    this.publishConnectionDeclaration();

    this.rootScope.addEventListener('settings_updated', ({key, settings}) => {
      if(key === 'settings.customDeviceModel') {
        this.setDeviceModel(settings.customDeviceModel);
      }
    });

    return this.appStateManager.getState().then((state) => {
      this.setDeviceModel(state.settings?.customDeviceModel);
    });
  }

  public removeNetworker(networker: MTPNetworker) {
    indexOfAndSplice(this.networkers, networker);
  }

  public setUpdatesProcessor(callback: (obj: any) => void) {
    this.updatesProcessor = callback;
  }

  // * what every networker is made with
  private getInitConnectionParams() {
    return {
      id: App.id,
      deviceModel: this.customDeviceModel || getEnvironment().USER_AGENT || 'Unknown UserAgent',
      systemVersion: navigator.platform || 'Unknown Platform',
      version: App.version + (App.isMainDomain ? ' ' + App.suffix : ''),
      systemLangCode: navigator.language || 'en',
      langPack: App.langPack,
      langCode: this.language
    };
  }

  /**
   * The same values the MTProto networker wraps its first query in, handed to the gRPC transport
   * for this account slot (the networker's own wrapper is unused there). tz_offset is seconds east
   * of UTC rounded to 15 minutes, like tdesktop's initConnection params
   * (session_private.cpp:555-573); the browser offset already lies inside its -12h..+14h range.
   */
  private publishConnectionDeclaration() {
    const params = this.getInitConnectionParams();
    setConnectionDeclaration(this.getAccountNumber(), {
      apiId: params.id,
      deviceModel: params.deviceModel,
      systemVersion: params.systemVersion,
      appVersion: params.version,
      systemLangCode: params.systemLangCode,
      langPack: params.langPack,
      langCode: params.langCode,
      tzOffset: Math.round(-new Date().getTimezoneOffset() * 60 / TimezoneRoundingSeconds) * TimezoneRoundingSeconds
    });
  }

  // * what every networker is made with
  private getCommonOptions() {
    return {
      timeManager: this.timeManager,
      getInitConnectionParams: () => this.getInitConnectionParams(),
      getBaseDcId: () => this.apiManager.getBaseDcId(),
      createLogger: this.createLogger.bind(this)
    };
  }

  public getNetworker(options: Omit<
    ConstructorParameters<typeof MTPNetworker>[0],
    'networkerFactory' | 'timeManager' | 'getBaseDcId' | 'updatesProcessor' | 'getInitConnectionParams'
  >) {
    const networker = new MTPNetworker({
      ...options,
      ...this.getCommonOptions(),
      isForcedStopped: () => this.akStopped,
      updatesProcessor: (obj) => this.updatesProcessor?.(obj),
      onConnectionStatus: (status) => {
        this.rootScope.dispatchEvent('connection_status_change', status);
      },
      onServerSalt: (serverSalt) => {
        AccountController.update(this.getAccountNumber(), {
          [`dc${options.dcId}_server_salt`]: bytesToHex(serverSalt)
        });
      }
    });
    this.networkers.push(networker);
    return networker;
  }

  /**
   * A networker for a single job over a connection of its own — binding a
   * temporary key. It stays out of the pool: no connection status, no
   * updates, no salt to keep.
   */
  public getHelperNetworker(options: Pick<
    ConstructorParameters<typeof MTPNetworker>[0],
    'dcId' | 'permAuthKey' | 'authKey' | 'serverSalt'
  >) {
    return new MTPNetworker({
      ...options,
      ...this.getCommonOptions(),
      isFileDownload: false,
      isFileUpload: false
    });
  }

  public startAll() {
    if(this.akStopped) {
      const stoppedNetworkers = this.networkers.filter((networker) => networker.isStopped());

      this.akStopped = false;
      this.updatesProcessor && this.updatesProcessor({_: 'new_session_created'});

      for(const networker of stoppedNetworkers) {
        networker.sendPingDelayDisconnect();
        networker.scheduleRequest();
      }
    }
  }

  public stopAll() {
    this.akStopped = true;
  }

  public setLanguage(langCode: string) {
    if(this.language === langCode) {
      return;
    }

    this.language = langCode;
    this.publishConnectionDeclaration();
    this.resetConnectionInited();
  }

  /**
   * The name this device shows up under in everyone's Active Sessions. Only
   * initConnection carries it, so re-init the client networkers to push it.
   */
  public setDeviceModel(deviceModel: string) {
    deviceModel ||= '';
    if(this.customDeviceModel === deviceModel) {
      return;
    }

    this.customDeviceModel = deviceModel;
    this.publishConnectionDeclaration();
    this.resetConnectionInited();
  }

  private resetConnectionInited() {
    for(const networker of this.networkers) {
      if(!networker.isFileNetworker) {
        networker.connectionInited = false;
      }
    }
  }

  public unsetConnectionInited() {
    for(const networker of this.networkers) {
      networker.connectionInited = false;
    }
  }

  public forceReconnectTimeout() {
    for(const networker of this.networkers) {
      networker.forceReconnectTimeout();
    }
  }

  public forceReconnect() {
    for(const networker of this.networkers) {
      if(!networker.isFileNetworker) {
        networker.forceReconnect();
        break;
      }
    }
  }
}
