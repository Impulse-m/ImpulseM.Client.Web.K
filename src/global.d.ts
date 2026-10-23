import type ListenerSetter from '@helpers/listenerSetter';
import type {Middleware, MiddlewareHelper} from '@helpers/middleware';
import type {Chat, Document, Message, User} from '@layer';
import type {MediaSize} from '@helpers/mediaSize';
import type {AnimationItemGroup} from '@components/animationIntersector';
import type LazyLoadQueue from '@components/lazyLoadQueue';
import type {AppManagers} from '@lib/managers';
import type {CustomProperty} from '@helpers/dom/customProperties';
import type Icons from '@/icons';
import type {CancellablePromise} from '@helpers/cancellablePromise';
import type Languages from '@lib/tinyld/languages';
import type {ValueOrGetter} from '@helpers/solid/readValue';
import type {MTAppConfig as AppConfig} from '@/appConfig';

declare global {
  interface AddEventListenerOptions extends EventListenerOptions {
    once?: boolean;
    passive?: boolean;
    // ls?: ListenerSetter;
  }

  interface HTMLCanvasElement {
    dpr?: number
  }

  interface HTMLElement {
    middlewareHelper?: MiddlewareHelper;
    timeAppenders?: {element: HTMLElement, callback: () => void}[];
    timeSpan?: HTMLElement;
    onMiniVideoMouseMove?: (e: MouseEvent) => void;
    message?: Message;
    // middleware?: Middleware;
  }

  interface HTMLMediaElement {
    isSeeking?: boolean;
    ignoreLeak?: boolean;
  }

  interface HTMLVideoElement {
    _loop?: boolean | number;
    _autoplay?: boolean;
    mini?: boolean;
  }

  interface Window {
    fillChatInputEditorTestData?: () => boolean | Promise<boolean>;
    Prism?: {
      manual?: boolean
    };
    documentPictureInPicture?: DocumentPictureInPicture;
  }

  // https://developer.chrome.com/docs/web-platform/document-picture-in-picture
  interface DocumentPictureInPictureOptions {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }

  interface DocumentPictureInPicture extends EventTarget {
    readonly window: Window | null;
    requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
    onenter: ((this: DocumentPictureInPicture, ev: Event) => any) | null;
  }

  interface NotificationAction {
    action: string;
    title: string;
  }

  interface NotificationOptions {
    actions?: NotificationAction[];
  }

  // * remove these types when navigation api is stable

  interface NavigationEntry {
    key: string;
    url: string;
    getState(): any;
    sameDocument: boolean;
    index: number;
  }

  interface NavigationOptions {
    state: any;
    history: 'push' | 'replace';
  }

  interface NavigationEvent extends Event {
    navigationType: 'push' | 'replace' | 'reload' | 'traverse';
    destination: NavigationEntry;
    sameDocument: boolean;
    intercept(options?: {
      handler?: () => void,
      focusReset?: 'after-transition' | 'manual',
      scroll?: 'after-transition' | 'manual'
    }): void;
    scroll(): void;
  }

  interface Navigation {
    entries(): NavigationEntry[];
    currentEntry: NavigationEntry;
    navigate(url: string | URL, options: NavigationOptions): void;
    traverseTo(key: string): void;
    updateCurrentEntry(options: NavigationEntryOptions): void;
    addEventListener(type: 'navigate', listener: (event: NavigationEvent) => void): void;
    removeEventListener(type: 'navigate', listener: (event: NavigationEvent) => void): void;
    back(): void;
  }

  const navigation: Navigation;

  // * until here

  // typescript is lack of types
  interface Selection {
    modify(alter: 'move' | 'extend', direction: 'forward' | 'backward' | 'left' | 'right', granularity: 'character' | 'word' | 'sentence' | 'line' | 'paragraph' | 'lineboundary' | 'sentenceboundary' | 'paragraphboundary' | 'documentboundary'): void;
  }

  type UserId = User.user['id'];
  type ChatId = Chat.chat['id'];
  // type PeerId = `u${UserId}` | `c${ChatId}`;
  // type PeerId = `${UserId}` | `-${ChatId}`;
  type PeerId = number;
  // type PeerId = number;
  type BotId = UserId;
  type DocId = Document.document['id'];
  type Long = string | number;
  type MTLong = string;
  type MTAppConfig = AppConfig;

  type AppEmoji = {emoji: string, docId?: DocId};
  type Icon = keyof typeof Icons;
  type PremiumPromoFeatureType = 'stories' | 'double_limits' | 'voice_to_text' | 'faster_download' |
    'translations' | 'animated_emoji' | 'more_upload' | 'emoji_status' | 'profile_badge' |
    'advanced_chat_management' | 'no_ads' | 'app_icons' | 'infinite_reactions' |
    'animated_userpics' | 'premium_stickers' | 'peer_colors' | 'wallpapers' |
    'saved_tags' | 'last_seen' | 'message_privacy' | 'pm_noforwards';

  type MTMimeType = 'video/quicktime' | 'image/gif' | 'image/jpeg' | 'application/pdf' |
    'video/mp4' | 'image/webp' | 'audio/aac' | 'audio/flac' | 'audio/mp4' | 'audio/mpeg' |
    'audio/ogg' | 'video/ogg' | 'application/octet-stream' |
    'application/x-tgsticker' | 'video/webm' | 'image/svg+xml' | 'image/png' | 'application/json' |
    'application/x-tgwallpattern' | 'audio/wav' | 'image/avif' | 'image/jxl' | 'image/bmp' |
    'image/heic' | 'application/x-mpegurl' | 'application/x-tgstoryboard' | 'application/x-tgstoryboardmap';

  type MTFileExtension = 'mov' | 'gif' | 'pdf' | 'jpg' | 'jpeg' | 'wav' |
    'tgv' | 'tgs' | 'svg' | 'mp4' | 'webm' | 'webp' | 'mp3' | 'm4a' | 'aac' |
    'flac' | 'opus' | 'oga' | 'ogg' | 'ogv' | 'json' |
    'png' | 'avif' | 'jxl' | 'bmp' | 'heic' | 'heif';

  type ApiFileManagerError = 'DOWNLOAD_CANCELED' | 'UPLOAD_CANCELED' | 'FILE_TOO_BIG' | 'REFERENCE_IS_NOT_REFRESHED';
  type StorageError = 'STORAGE_OFFLINE' | 'NO_ENTRY_FOUND' | 'IDB_CREATE_TIMEOUT';
  type ReferenceError = 'NO_NEW_CONTEXT' | 'NO_CONTEXT';
  type NetworkerError = 'NETWORK_BAD_RESPONSE' | 'NETWORK_BAD_REQUEST' | 'BIND_FAILED';
  type FiltersError = 'PINNED_DIALOGS_TOO_MUCH' | 'PINNED_DIALOGS_CHANGED';
  type LottieError = 'FRAME_OUT_OF_RANGE' | 'ITEM_DESTROYED' | 'FILE_INVALID';

  type LocalFileError = ApiFileManagerError | ReferenceError | StorageError;
  type LocalErrorType = LocalFileError | NetworkerError | FiltersError | LottieError |
    'UNKNOWN' | 'NO_DOC' | 'MIDDLEWARE' | 'PORT_DISCONNECTED' | 'NO_AUTO_DOWNLOAD' | 'CHAT_PRIVATE' | 'NO_WASM' |
    'CANCELED' | 'TIMEOUT' | 'TAB_ALREADY_OPEN' | 'MEDIA_ID_PENDING' |
    // ImpulseM gRPC transport invariants — a TL method reached the gateway
    // bridge without a proto mapping, or the generated client lacks it.
    'GRPC_METHOD_UNMAPPED' | 'GRPC_METHOD_MISSING' | 'FLEET_IDENTITY_UNREGISTERED' |
    // Raised instead of opening an MTProto connection: the gateway speaks gRPC only.
    'NETWORKER_DISABLED';

  // The canon catalog is generated into canonErrors.d.ts from the vendored
  // snapshot -- see `pnpm run generate-error-types`. Only identifiers the
  // catalog does not publish are listed here: tweb's own sentinels, ImpulseM
  // extensions, and errors newer than the snapshot.
  type ServerErrorType = CanonServerErrorType
    | 'ERROR_EMPTY'
    | 'MTPROTO_CLUSTER_INVALID'
    | 'BOT_PRECHECKOUT_TIMEOUT'
    | 'AICOMPOSE_FLOOD_PREMIUM'
    | 'AICOMPOSE_TONE_SLUG_INVALID'
    | 'AICOMPOSE_TONE_INVALID'
    | 'TONE_NOT_FOUND'
    | 'FILTERS_TOO_MUCH'
    | 'DIALOG_FILTERS_TOO_MUCH'
    | 'NO_USER'
    | 'PREMIUM_GIFTED_NOT_ALLOWED'
    | 'MESSAGE_ID_REQUIRED'
    | 'SAVED_DIALOGS_UNSUPPORTED'
    | 'TIME_TOO_BIG'
    | 'TIME_TOO_SMALL'
    | 'TIME_INVALID'
    | 'VIDEO_CHANNEL_INVALID'
    | 'STORY_ID_TOO_MANY'
    | 'ADDRESS_STREET_LINE1_INVALID'
    | 'ADDRESS_STREET_LINE2_INVALID'
    | 'ADDRESS_COUNTRY_INVALID'
    | 'ADDRESS_CITY_INVALID'
    | 'ADDRESS_STATE_INVALID'
    | 'ADDRESS_POSTCODE_INVALID'
    | 'REQ_INFO_NAME_INVALID'
    | 'REQ_INFO_EMAIL_INVALID'
    | 'REQ_INFO_PHONE_INVALID'
    | '2FA_RECENT_CONFIRM'
    | 'PASSKEY_CREDENTIAL_NOT_FOUND'
    | 'SUMMARY_FLOOD_PREMIUM'
    | 'GROUP_FULL'
    | 'ACCESS_DENIED'
    | 'CHANNEL_ALREADY_LINKED'
    | 'COMMUNITY_REQUEST_CREATED'
    | 'COMMUNITY_PEERS_TOO_MUCH'
    | 'USER_WAS_KICKED'
    | 'FRESH_CHANGE_AUTHORIZATION_FORBIDDEN'
    ;

  type ErrorType = LocalErrorType | ServerErrorType;

  type ImpulseMChoosePeerType = 'users' | 'bots' | 'groups' | 'channels';

  type TranslatableLanguageISO = typeof Languages[number][0];

  type ApiError = {
    type: ErrorType,
    stack?: string,
    message?: string,
    code?: number,
    handled?: boolean,
    originalError?: any,
    cause?: unknown,
  };

  // read it through getElectronHelpers() from @helpers/electronHelpers — a bare `typeof` check also
  // matches any element whose id happens to be `electronHelpers`, which message content can render
  const electronHelpers: {
    openExternal(url): void;
  } | undefined;

  type DOMRectMinified = {top: number, right: number, bottom: number, left: number};
  type DOMRectEditable = DOMRectMinified & {width: number, height: number};
  type MaybePromise<T> = Promise<T> | T;
  type MaybeDeferredPromise<T> = CancellablePromise<T> | T;

  type WrapSomethingOptions = {
    lazyLoadQueue?: LazyLoadQueue | false,
    middleware?: Middleware,
    customEmojiSize?: MediaSize,
    textColor?: ValueOrGetter<CustomProperty>,
    animationGroup?: AnimationItemGroup,
    managers?: AppManagers
  };
}
