/**
 * Single place that reads the ImpulseM build-time settings.
 *
 * The values are IMPULSEM_* variables. CI passes them from the organisation variables; a local build
 * reads them from the environment or .env.local (Vite exposes the IMPULSEM_ prefix, see envPrefix in
 * vite.config.ts). An empty value means "not configured": nothing is dialled, and no link or UI entry
 * is built from it. Every consumer goes through the accessors below.
 *
 *   IMPULSEM_RPC_URL    base URL of the transport host (gRPC-web, Centrifugo update socket, Loki push)
 *   IMPULSEM_SITE_URL   base URL of the project website, e.g. https://example.org
 *   IMPULSEM_LINK_HOST  host of public share links (the t.me equivalent), e.g. o.example.org
 *   IMPULSEM_WEB_URL    URL of the web client, e.g. https://web.example.org/k
 *
 * The derived Centrifugo endpoints keep the paths of the transport (fleet/fleetPath.ts).
 */

/** The text a site link carries in lang strings; resolved by resolveSiteLinkTokens. */
export const SITE_URL_TOKEN: string = '{IMPULSEM_SITE_URL}';

const SITE_LINK_PATTERN: RegExp = /\[([^\]]*)\]\(\{IMPULSEM_SITE_URL\}([^)]*)\)/g;

function trimTrailingSlashes(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function impulsemRpcUrl(): string {
  return trimTrailingSlashes(import.meta.env?.IMPULSEM_RPC_URL);
}

export function impulsemSiteUrl(): string {
  return trimTrailingSlashes(import.meta.env?.IMPULSEM_SITE_URL);
}

export function impulsemLinkHost(): string {
  return (import.meta.env?.IMPULSEM_LINK_HOST ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

export function impulsemWebUrl(): string {
  return trimTrailingSlashes(import.meta.env?.IMPULSEM_WEB_URL);
}

/** The host name of the web client, or an empty string when IMPULSEM_WEB_URL is not set or invalid. */
export function impulsemWebHostname(): string {
  const webUrl: string = impulsemWebUrl();
  if(!webUrl) {
    return '';
  }

  try {
    return new URL(webUrl).hostname;
  } catch{
    return '';
  }
}

/** A link to a page of the website: SITE_URL + path, or undefined when no site is configured. */
export function impulsemSiteLink(path: string): string | undefined {
  const siteUrl: string = impulsemSiteUrl();
  return siteUrl ? siteUrl + path : undefined;
}

/** A public share link on the link host: https://LINK_HOST + path, or undefined when no link host is configured. */
export function impulsemShareLink(path: string): string | undefined {
  const linkHost: string = impulsemLinkHost();
  return linkHost ? `https://${linkHost}${path}` : undefined;
}

/**
 * Replaces the site tokens of a lang string. `[label]({IMPULSEM_SITE_URL}/path)` becomes a link to
 * SITE_URL + path, or the bare label when no site is configured; a bare token becomes SITE_URL.
 */
export function resolveSiteLinkTokens(text: string): string {
  if(!text.includes(SITE_URL_TOKEN)) {
    return text;
  }

  const siteUrl: string = impulsemSiteUrl();
  if(!siteUrl) {
    return text.replace(SITE_LINK_PATTERN, '$1').split(SITE_URL_TOKEN).join('');
  }

  return text
  .replace(SITE_LINK_PATTERN, (match: string, label: string, path: string) => `[${label}](${siteUrl}${path})`)
  .split(SITE_URL_TOKEN).join(siteUrl);
}

/**
 * The HTTP origin of the transport host, or an empty string when IMPULSEM_RPC_URL is not set.
 * Read at call time: e2e/live imports backendWsOrigin, and import.meta.env is undefined outside Vite.
 */
export function backendHttpOrigin(): string {
  return impulsemRpcUrl();
}

export function backendWsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, 'ws');
}

/** The websocket origin of the update socket, or an empty string when no transport host is configured. */
export function backendUpdateWsOrigin(): string {
  return import.meta.env?.VITE_IMPULSE_UPDATE_WS || backendWsOrigin(backendHttpOrigin());
}

export function backendPoolWsOrigin(): string | undefined {
  return import.meta.env?.VITE_IMPULSE_POOL_WS || undefined;
}
