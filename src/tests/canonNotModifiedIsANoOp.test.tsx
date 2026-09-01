import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {render} from 'solid-js/web';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

/*
 * Canon answers "you already have what you asked for" with a `*_NOT_MODIFIED`
 * error code, and says in so many words that this is a success, not a failure:
 *
 *   .demo/telegram-docs-text/api/peers.md:1226-1228
 *     "After invoking the following methods (both if the call succeeds and after
 *      receiving a USERNAME_NOT_MODIFIED error, which is also a success)"
 *
 *   .demo/telegram-docs-text/method/account.updateUsername.md:86-88
 *     "400 / USERNAME_NOT_MODIFIED / The username was not modified."
 *
 * Issue #139: submitting the profile editor with the username already held made
 * the client crash out of the save with an unhandled promise rejection. The
 * codes below are a family, not one string, so the invariant is pinned over the
 * whole family the canon catalog publishes rather than over the one sample the
 * CEO happened to hit.
 *
 * Nothing here asserts on where the absorption lives. The tests drive the
 * editors the way a user does and only look at what the user can see: the
 * editor closes, nothing is logged as an error, nothing escapes as an unhandled
 * rejection.
 */

const mocks = vi.hoisted(() => ({
  collected: undefined as Promise<unknown> | undefined,
  tab: undefined as any
}));

// ── shared component mocks ─────────────────────────────────────────────────

vi.mock('@components/solidJsTabs/superTabProvider', () => ({
  useSuperTab: () => [mocks.tab]
}));

vi.mock('@components/solidJsTabs/promiseCollector', () => ({
  usePromiseCollector: () => ({
    collect: (promise: Promise<unknown>) => {
      mocks.collected = promise;
    }
  })
}));

vi.mock('@components/solidJsTabs/tabs', () => ({
  AppAddChatToCommunityTab: Symbol('AppAddChatToCommunityTab'),
  AppChatAdministratorsTab: Symbol('AppChatAdministratorsTab'),
  AppChatAutomationTab: Symbol('AppChatAutomationTab'),
  AppCommunityPendingRequestsTab: Symbol('AppCommunityPendingRequestsTab'),
  AppEditCommunityTab: Symbol('AppEditCommunityTab'),
  AppEditProfileTab: Symbol('AppEditProfileTab'),
  AppRemovedUsersTab: Symbol('AppRemovedUsersTab')
}));

vi.mock('@lib/solidjs/hotReloadGuard', () => ({
  useHotReloadGuard: () => ({appSidebarLeft: {}})
}));

vi.mock('@lib/langPack', () => ({
  i18n: (key: string) => document.createTextNode(key)
}));

vi.mock('@components/section', () => ({
  default: (props: any) => <section>{props.children}</section>
}));

vi.mock('@components/rowTsx', () => {
  const Row = (props: any) => (
    <button type="button" onClick={props.clickable}>
      {props.children}
    </button>
  );
  Row.Icon = () => <span />;
  Row.Title = (props: any) => <span>{props.children}</span>;
  return {default: Row};
});

vi.mock('@components/iconTsx', () => ({
  IconTsx: (props: {class?: string}) => <span class={props.class} />
}));

vi.mock('@components/badge', () => ({
  default: (props: any) => <span>{props.children}</span>
}));

// Serves both editors: the profile editor takes the field instance through
// `instanceRef`, the community editor reads raw input through `onRawInput`.
vi.mock('@components/inputFieldTsx', () => ({
  InputFieldTsx: (props: any) => {
    const input = document.createElement('input');
    input.name = props.name || '';
    input.dataset.name = props.name || '';
    input.value = typeof props.value === 'string' ? props.value : '';

    const field = {
      input,
      originalValue: '',
      required: false,
      get value() {
        return input.value;
      },
      set value(next: string) {
        input.value = next;
      },
      setOriginalValue(value = '') {
        field.originalValue = value;
        input.value = value;
      },
      isValid: () => true,
      isChanged: () => input.value !== field.originalValue,
      isValidToChange: () => field.isValid() && field.isChanged()
    };

    input.addEventListener('input', () => props.onRawInput?.(input.value));
    props.instanceRef?.(field);
    return input;
  }
}));

vi.mock('@components/buttonTsx', () => {
  const makeButton = (props: any) => {
    const button = document.createElement(props.as === 'a' ? 'a' : 'button');
    button.dataset.testid = 'save';
    if(props.icon) {
      button.dataset.icon = props.icon;
    }
    if(props.disabled) {
      button.setAttribute('disabled', '');
    }
    props.ref?.(button);
    props.onClick && button.addEventListener('click', props.onClick);
    return button;
  };
  return {default: Object.assign(makeButton, {Corner: makeButton})};
});

vi.mock('@components/toast', () => ({
  toast: vi.fn(),
  toastNew: vi.fn()
}));

// ── profile editor mocks ───────────────────────────────────────────────────

vi.mock('@components/editPeer', () => ({
  default: class {
    public nextBtn = document.createElement('button');
    public uploadAvatar: unknown = undefined;
    public avatarEdit = {container: document.createElement('div')};
    public avatarElem = {node: document.createElement('div')};

    constructor() {
      this.nextBtn.dataset.testid = 'save';
    }

    public isChanged = () => true;

    public handleChange = () => {};
  }
}));

vi.mock('@components/usernameInputField', () => ({
  UsernameInputField: class {
    public container = document.createElement('div');
    public input = document.createElement('input');
    public originalValue = '';
    public error: unknown = undefined;

    constructor() {
      this.input.dataset.name = 'username';
      this.container.append(this.input);
    }

    public get value() {
      return this.input.value;
    }

    public set value(next: string) {
      this.input.value = next;
    }

    public setOriginalValue(value = '') {
      this.originalValue = value;
      this.input.value = value;
    }

    public isValid() {
      return true;
    }

    public isChanged() {
      return this.input.value !== this.originalValue;
    }

    public isValidToChange() {
      return this.isValid() && this.isChanged();
    }
  }
}));

vi.mock('@components/usernamesSection', () => ({default: (): null => null}));

vi.mock('@components/sidebarLeft/tabs/purchaseUsernameCaption', () => ({
  purchaseUsernameCaption: () => ({
    element: document.createElement('span'),
    setUsername: vi.fn()
  })
}));

vi.mock('@components/popups/birthday', () => ({
  default: vi.fn(),
  saveMyBirthday: vi.fn()
}));

vi.mock('@components/popups/pickUser', () => ({default: vi.fn()}));

vi.mock('@components/popups/indexTsx', () => ({
  default: {FooterButton: (): null => null}
}));

vi.mock('@components/wrappers/peerTitle', () => ({
  default: vi.fn().mockResolvedValue(document.createTextNode('Peer'))
}));

vi.mock('@helpers/dom/clickEvent', () => ({
  attachClickEvent: (element: HTMLElement, callback: (event: Event) => void) => {
    element.addEventListener('click', callback);
  }
}));

vi.mock('@helpers/dom/placeCaretAtEnd', () => ({default: vi.fn()}));

vi.mock('@helpers/dom/shake', () => ({default: vi.fn()}));

vi.mock('@hooks/useHeavyAnimationCheck', () => ({
  getHeavyAnimationPromise: () => Promise.resolve()
}));

vi.mock('@stores/avatarUpload', () => ({trackAvatarUpload: vi.fn()}));

vi.mock('@lib/rootScope', () => ({
  default: {
    myId: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
}));

// ── community editor mocks ─────────────────────────────────────────────────

vi.mock('@components/avatarEdit', () => ({
  default: class {
    public container = document.createElement('div');
    public clear = vi.fn();
  }
}));

vi.mock('@components/communities/communityAvatar', () => ({
  default: (): null => null,
  CommunityAvatarEditor: (): null => null
}));

vi.mock('@components/communities/communityPeerDialogList', () => ({
  default: (): null => null
}));

vi.mock('@components/communities/communityShared', () => ({
  CommunityManagementRow: (): null => null,
  CommunityPendingRequestsRow: (): null => null,
  CommunityRadioOption: (): null => null,
  communitySharedStyles: {
    editorFields: 'editorFields',
    editorHero: 'editorHero',
    footerAction: 'footerAction',
    hero: 'hero',
    hiddenPeerIcon: 'hiddenPeerIcon',
    root: 'root',
    saveCorner: 'saveCorner'
  }
}));

vi.mock('@components/communities/useCommunityTabGuard', () => ({default: vi.fn()}));

vi.mock('@components/communities/openCommunityPendingRequests', () => ({
  default: vi.fn()
}));

vi.mock('@components/popups/channelsTooMuch', () => ({
  handleChannelsTooMuch: (callback: () => unknown) => callback()
}));

vi.mock('@components/confirmationPopup', () => ({default: vi.fn()}));

vi.mock('@components/wrappers/getPeerTitle', () => ({
  default: vi.fn().mockResolvedValue('Linked chat')
}));

vi.mock('@lib/appImManager', () => ({
  default: {openJoinChatWebView: vi.fn(), setInnerPeer: vi.fn()}
}));

vi.mock('@lib/apiManagerProxy', () => ({default: {getPeer: (): undefined => undefined}}));

const communityState = vi.hoisted(() => ({
  community: undefined as any,
  communityFull: undefined as any
}));

vi.mock('@stores/communities', () => ({
  useCommunity: () => () => communityState.community,
  useCommunityFull: () => () => communityState.communityFull,
  useCommunityPendingRequestsCount: () => () => 0
}));

import {toastNew} from '@components/toast';
import EditCommunity from '@components/communities/editCommunity';
import EditProfileTab from '@components/sidebarLeft/tabs/editProfile';

// ── the canon family ───────────────────────────────────────────────────────

/**
 * Every `*_NOT_MODIFIED` identifier the generated canon catalog publishes. Read
 * from the catalog rather than hand-listed: the fix has to be the family, and a
 * hand-list would quietly stop covering codes canon adds later.
 */
function readCanonNotModifiedFamily(): string[] {
  const catalog = readFileSync(
    resolve(__dirname, '..', 'canonErrors.d.ts'),
    'utf8'
  );
  const found = catalog.match(/'[A-Z0-9_]+_NOT_MODIFIED'/g) || [];
  return Array.from(new Set(found.map((quoted) => quoted.slice(1, -1)))).sort();
}

const NOT_MODIFIED_FAMILY = readCanonNotModifiedFamily();

/** The shape the gRPC boundary hands a caller for a canon error code. */
function canonError(type: string): ApiError {
  return {type: type as ErrorType, code: 400} as ApiError;
}

// ── observation helpers ────────────────────────────────────────────────────

type RejectionWatch = {
  escaped: unknown[],
  stop: () => void
};

/**
 * Watches for the exact thing the CEO saw in the console: a rejection nobody
 * handled. jsdom does not implement the `unhandledrejection` event itself, so
 * the process hook is the one that actually fires; the window listener is kept
 * for the day it does.
 */
function watchUnhandledRejections(): RejectionWatch {
  const escaped: unknown[] = [];
  const onProcess = (reason: unknown) => escaped.push(reason);
  const onWindow = (event: Event) => escaped.push((event as any).reason);

  process.on('unhandledRejection', onProcess);
  window.addEventListener('unhandledrejection', onWindow);

  return {
    escaped,
    stop: () => {
      process.off('unhandledRejection', onProcess);
      window.removeEventListener('unhandledrejection', onWindow);
    }
  };
}

/** Lets the microtask queue drain far enough for Node to report a rejection. */
async function settle() {
  for(let turn = 0; turn < 4; ++turn) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function describeEscaped(escaped: unknown[]): string {
  return escaped
  .map((reason) => (reason as any)?.type ?? JSON.stringify(reason))
  .join(', ');
}

describe('a canon *_NOT_MODIFIED answer is a no-op, not a failure', () => {
  let dispose: VoidFunction;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let rejections: RejectionWatch;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collected = undefined;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    rejections = watchUnhandledRejections();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    rejections.stop();
    consoleError.mockRestore();
    document.body.replaceChildren();
  });

  it('publishes a whole family of codes, not one string', () => {
    expect(
      NOT_MODIFIED_FAMILY.length,
      'src/canonErrors.d.ts published no *_NOT_MODIFIED code at all, so every ' +
      'family assertion below measured nothing — regenerate the catalog before ' +
      'trusting this file'
    ).toBeGreaterThan(1);
    expect(
      NOT_MODIFIED_FAMILY,
      'the code issue #139 was filed against must be in the family the fix covers'
    ).toContain('USERNAME_NOT_MODIFIED');
    expect(
      NOT_MODIFIED_FAMILY,
      'CHAT_NOT_MODIFIED is canon for channels.editTitle and is the second path ' +
      'pinned below; a family missing it is not the canon family'
    ).toContain('CHAT_NOT_MODIFIED');
  });

  describe('the profile editor', () => {
    const myUsername = 'kylenekto';

    let updateProfile: ReturnType<typeof vi.fn>;
    let updateUsername: ReturnType<typeof vi.fn>;
    let tabContent: HTMLElement;

    beforeEach(() => {
      updateProfile = vi.fn().mockResolvedValue(undefined);
      updateUsername = vi.fn().mockResolvedValue(undefined);
      tabContent = document.createElement('div');
      document.body.append(tabContent);

      mocks.tab = {
        close: vi.fn(),
        container: document.createElement('div'),
        content: tabContent,
        listenerSetter: {
          add: (target: any) => (event: string, callback: any) => {
            target?.addEventListener?.(event, callback);
          }
        },
        managers: {
          appBusinessManager: {
            getConnectedBot: vi.fn().mockResolvedValue(undefined)
          },
          appProfileManager: {
            getAdminedPersonalChannels: vi.fn().mockResolvedValue([]),
            updatePersonalChannel: vi.fn().mockResolvedValue(undefined),
            updateProfile,
            uploadProfilePhoto: vi.fn().mockResolvedValue(undefined)
          },
          appUsersManager: {updateUsername}
        },
        middlewareHelper: {get: () => (() => true)},
        payload: {
          bioMaxLength: 70,
          connectedBot: Promise.resolve(undefined),
          user: {
            _: 'user',
            id: 1 as UserId,
            pFlags: {self: true},
            first_name: 'Kyle',
            last_name: 'Nekto'
          },
          userFull: {_: 'userFull', pFlags: {}, id: 1 as UserId, about: 'Bio'}
        },
        slider: {createTab: vi.fn(() => ({open: vi.fn()}))}
      };
    });

    /**
     * Opens the editor and submits it the way a user does: the username field
     * carries the username the account already holds (live, the editor opens
     * with the field empty because the account's username is not echoed back as
     * editable, so retyping it is the ordinary way to reach this), everything
     * else untouched, then the save button is clicked.
     */
    async function submitWithUnchangedUsername() {
      const container = document.createElement('div');
      document.body.append(container);
      dispose = render(() => <EditProfileTab />, container);
      await mocks.collected;
      await vi.waitFor(() => {
        expect(container.querySelector('[data-name="username"]')).not.toBeNull();
      });

      const username = container.querySelector<HTMLInputElement>(
        '[data-name="username"]'
      );
      username.value = myUsername;
      username.dispatchEvent(new InputEvent('input', {bubbles: true}));

      tabContent.querySelector<HTMLButtonElement>('[data-testid="save"]').click();
      await settle();
    }

    it('closes normally when the username submitted is the one already held', async() => {
      updateUsername.mockRejectedValue(canonError('USERNAME_NOT_MODIFIED'));

      await submitWithUnchangedUsername();

      expect(
        updateUsername,
        'the editor must actually have asked the server to set the username, ' +
        'otherwise this test never reaches the answer it is about'
      ).toHaveBeenCalledWith(myUsername);
      expect(
        rejections.escaped.length,
        'USERNAME_NOT_MODIFIED escaped the save as an unhandled promise ' +
        'rejection — canon (api/peers.md:1226-1228) calls that answer a ' +
        `success, so nothing may escape: [${describeEscaped(rejections.escaped)}]`
      ).toBe(0);
      expect(
        mocks.tab.close,
        'the editor stayed open after asking for a username the account ' +
        'already holds; asking for a state that already holds is a no-op and ' +
        'the editor must close'
      ).toHaveBeenCalled();
      expect(
        consoleError,
        'a canon no-op answer was logged as an error'
      ).not.toHaveBeenCalled();
    });

    it.each(NOT_MODIFIED_FAMILY)(
      'closes normally when the save is answered %s',
      async(code) => {
        updateUsername.mockRejectedValue(canonError(code));

        await submitWithUnchangedUsername();

        expect(
          rejections.escaped.length,
          `${code} escaped the save as an unhandled promise rejection. Every ` +
          'canon *_NOT_MODIFIED code means "you already have what you asked ' +
          'for"; absorbing only USERNAME_NOT_MODIFIED fixes the instance, not ' +
          `the family: [${describeEscaped(rejections.escaped)}]`
        ).toBe(0);
        expect(
          mocks.tab.close,
          `the editor stayed open after the no-op answer ${code}`
        ).toHaveBeenCalled();
        expect(
          consoleError,
          `the canon no-op answer ${code} was logged as an error`
        ).not.toHaveBeenCalled();
      }
    );

    it('still fails the save when the answer is a real error', async() => {
      // ABOUT_TOO_LONG is canon for account.updateProfile
      // (.demo/telegram-docs-text/method/account.updateProfile.md). Absorbing
      // the *_NOT_MODIFIED family must not turn into swallowing everything.
      updateProfile.mockRejectedValue(canonError('ABOUT_TOO_LONG'));

      await submitWithUnchangedUsername();

      expect(
        mocks.tab.close,
        'ABOUT_TOO_LONG is a real refusal, not a no-op — the editor must not ' +
        'close as though the profile had been saved'
      ).not.toHaveBeenCalled();
      expect(
        consoleError,
        'a real refusal must still reach the client as a failure'
      ).toHaveBeenCalled();
    });
  });

  describe('the community editor', () => {
    const communityId = 10 as ChatId;
    // What the client still believes the title is...
    const cachedTitle = 'Impulse';
    // ...and what the server already holds, so the edit is a no-op there.
    const serverTitle = 'ImpulseM';

    let editTitle: ReturnType<typeof vi.fn>;
    let tabContent: HTMLElement;

    beforeEach(() => {
      editTitle = vi.fn().mockResolvedValue(undefined);
      tabContent = document.createElement('div');
      document.body.append(tabContent);

      communityState.community = {
        _: 'community',
        id: communityId,
        pFlags: {creator: true},
        title: cachedTitle,
        default_banned_rights: {
          _: 'chatBannedRights',
          pFlags: {},
          until_date: 2147483647
        }
      };
      communityState.communityFull = {
        _: 'communityFull',
        pFlags: {},
        id: communityId,
        about: '',
        admins_count: 1,
        kicked_count: 0,
        linked_peers: []
      };

      mocks.tab = {
        close: vi.fn(),
        content: tabContent,
        managers: {
          appChatsManager: {
            delete: vi.fn().mockResolvedValue(undefined),
            editPhoto: vi.fn().mockResolvedValue(undefined),
            editTitle,
            joinChannel: vi.fn().mockResolvedValue(undefined)
          },
          appCommunitiesManager: {
            editDefaultBannedRightsMode: vi.fn().mockResolvedValue(undefined),
            reloadCommunity: vi.fn().mockResolvedValue(undefined),
            togglePeerLink: vi.fn().mockResolvedValue(undefined)
          }
        },
        middlewareHelper: {get: () => ({})},
        payload: {communityId},
        slider: {createTab: vi.fn(() => ({open: vi.fn()}))}
      };
    });

    it('closes normally when the title submitted is the one already set', async() => {
      // CHAT_NOT_MODIFIED is canon for channels.editTitle:
      // "No changes were made to chat information because the new information
      //  you passed is identical to the current information."
      // The editor refuses to submit a title it knows to be unchanged, so the
      // only way this answer arrives is the way it arrives live: a stale cached
      // title makes the client believe the edit is a change when the server has
      // already stored it.
      editTitle.mockRejectedValue(canonError('CHAT_NOT_MODIFIED'));

      const container = document.createElement('div');
      document.body.append(container);
      dispose = render(() => <EditCommunity />, container);

      const title = container.querySelector<HTMLInputElement>(
        'input[name="community-name"]'
      );
      title.value = serverTitle;
      title.dispatchEvent(new InputEvent('input', {bubbles: true}));

      await vi.waitFor(() => {
        expect(
          tabContent.querySelector('[data-testid="save"]')
        ).not.toBeNull();
      });
      tabContent.querySelector<HTMLButtonElement>('[data-testid="save"]').click();
      await settle();

      expect(
        editTitle,
        'the editor must actually have asked the server to set the title, ' +
        'otherwise this test never reaches the answer it is about'
      ).toHaveBeenCalledWith(communityId, serverTitle);
      expect(
        rejections.escaped.length,
        'CHAT_NOT_MODIFIED escaped the community save as an unhandled ' +
        `rejection: [${describeEscaped(rejections.escaped)}]`
      ).toBe(0);
      expect(
        mocks.tab.close,
        'the community editor stayed open after asking for the title it ' +
        'already has; that answer is canon for a no-op, not a failure'
      ).toHaveBeenCalled();
      expect(
        toastNew,
        'a canon no-op answer was reported to the user as an error'
      ).not.toHaveBeenCalled();
      expect(
        consoleError,
        'a canon no-op answer was logged as an error'
      ).not.toHaveBeenCalled();
    });
  });
});
