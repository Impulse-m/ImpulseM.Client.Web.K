/**
 * The schemes of the links the client routes inside itself.
 *
 * `im:` is ImpulseM's own: the scheme the client claims from the operating system and builds for
 * links that leave it. `tg:` is the Telegram scheme, still read everywhere because server content
 * carries tg:// links.
 */
export const IMPULSEM_LINK_SCHEME: string = 'im';
export const TELEGRAM_LINK_SCHEME: string = 'tg';

/** The same schemes as `URL.protocol` spells them, colon included. */
export const LINK_SCHEME_PROTOCOLS: Array<string> = [
  IMPULSEM_LINK_SCHEME + ':',
  TELEGRAM_LINK_SCHEME + ':'
];
