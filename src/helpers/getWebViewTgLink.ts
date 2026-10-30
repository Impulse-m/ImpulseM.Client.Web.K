import {impulsemShareLink} from '@config/impulsemConfig';

// ! `path_full` is whatever the frame put in a `web_app_open_tg_link` event, so it cannot be pasted
// ! onto the bare host — a value that does not start with a slash lands in the host instead of the
// ! path ('.evil.com/x' would build https://o.example.org.evil.com/x)
// The link host comes from IMPULSEM_LINK_HOST; undefined when no link host is configured.
export default function getWebViewTgLink(pathFull: string): string | undefined {
  return impulsemShareLink('/' + (pathFull || '').replace(/^\/+/, ''));
}
