import {describe, expect, it, vi} from 'vitest';

vi.mock('@components/groupCall/index', () => ({
  GROUP_CALL_PARTICIPANT_MUTED_STATE: {UNMUTED: 0, MUTED: 1, MUTED_FOR_ME: 2, MUTED_BY_ADMIN: 3, HAND: 4}
}));
vi.mock('@lib/langPack', () => ({i18n: (key: string) => {
  const span = document.createElement('span');
  span.dataset.key = key;
  span.textContent = key;
  return span;
}}));
vi.mock('@components/icon', () => ({default: (name: string) => {
  const icon = document.createElement('i');
  icon.dataset.icon = name;
  return icon;
}}));
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({default: (text: string) => document.createTextNode(text)}));
vi.mock('@helpers/dom/setInnerHTML', () => ({default: (element: HTMLElement, content: Node) => {
  element.replaceChildren(content);
}}));

import GroupCallParticipantStatusElement from '@components/groupCall/participantStatus';

const STATES = {UNMUTED: 0, MUTED: 1, MUTED_FOR_ME: 2, MUTED_BY_ADMIN: 3, HAND: 4};

function render(state: number, options?: {withAccess?: boolean, isSpeaking?: boolean}, participant: any = {pFlags: {}}) {
  const status = new GroupCallParticipantStatusElement(['presentation', 'video']);
  status.setState(state as any, participant, options);
  const span = status.container.firstElementChild as HTMLElement;
  const srOnly = span?.querySelector('.sr-only');
  const visible = Array.from(span?.childNodes ?? []).filter((node) => node !== srOnly).map((node) => node.textContent).join('');
  return {status, span, srOnly, visible};
}

describe('group call participant status', () => {
  it('says speaking only while LiveKit reports the unmuted participant as speaking', () => {
    const speaking = render(STATES.UNMUTED, {isSpeaking: true});
    expect(speaking.visible).toBe('VoiceChat.Status.Speaking');
    expect(speaking.span.classList.contains('is-speaking')).toBe(true);
    expect(speaking.srOnly).toBeNull();
  });

  it('says listening for an unmuted participant who is silent, and does not add the muted text', () => {
    const silent = render(STATES.UNMUTED, {isSpeaking: false});
    expect(silent.visible).toBe('VoiceChat.Status.Listening');
    expect(silent.span.classList.contains('is-listening')).toBe(true);
    expect(silent.span.classList.contains('is-speaking')).toBe(false);
    expect(silent.srOnly).toBeNull();

    expect(render(STATES.UNMUTED).visible).toBe('VoiceChat.Status.Listening');
  });

  it.each([STATES.MUTED, STATES.MUTED_BY_ADMIN])('keeps a muted participant on listening and gives screen readers the muted state: %s', (state) => {
    const muted = render(state, {isSpeaking: true});

    expect(muted.visible).toBe('VoiceChat.Status.Listening');
    expect(muted.span.classList.contains('is-listening')).toBe(true);
    expect(muted.srOnly?.textContent).toBe(' VoiceChat.Status.Muted');
    // static text on the row: the status is not a live region
    expect(muted.status.container.querySelector('[aria-live]')).toBeNull();
    expect(muted.span.getAttribute('aria-live')).toBeNull();
  });

  it('keeps the other states as they were', () => {
    expect(render(STATES.MUTED_FOR_ME).visible).toBe('VoiceChat.Status.MutedForYou');
    expect(render(STATES.HAND).visible).toBe('VoiceChat.Status.WantsSpeak');
    const withAccess = render(STATES.UNMUTED, {withAccess: true, isSpeaking: true});
    expect(withAccess.visible).toBe('VoiceChat.Status.Listening');
    expect(withAccess.span.classList.contains('is-listening')).toBe(true);
  });

  it('shows what a muted participant wrote about themselves instead, when there is no icon', () => {
    const about = render(STATES.MUTED, undefined, {pFlags: {}, about: 'hello there'});
    expect(about.status.container.textContent).toBe('hello there');
    expect(about.status.container.querySelector('.sr-only')).toBeNull();
  });

  it('shows the icons of the media a participant shares', () => {
    const shared = render(STATES.UNMUTED, {isSpeaking: true}, {pFlags: {}, video: {}, presentation: {}});
    expect(Array.from(shared.span.querySelectorAll('i')).map((icon) => icon.dataset.icon)).toEqual([
      'listscreenshare_filled',
      'videocamera_filled'
    ]);
  });
});
