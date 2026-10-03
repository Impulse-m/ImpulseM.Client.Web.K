/*
 * The member tag popup: what it sends (messages.editChatParticipantRank with the tag cleaned of emoji and cut to 16),
 * what it shows when the server refuses (the canonical error code, popup left open), and how it is exposed to
 * assistive technology (a labelled field described by the explanation, a titled dialog with Save and Cancel).
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'solid-js/web';
import '@helpers/peerIdPolyfill';

const mocks = vi.hoisted(() => ({
  popupFactory: undefined as (() => any) | undefined,
  editChatParticipantRank: vi.fn(),
  fields: [] as {value: string}[],
  toast: vi.fn()
}));

vi.mock('@lib/langPack', () => ({
  i18n: (key: string, args?: unknown[]) => (args?.length ? `${key}:${args.join('|')}` : key)
}));
vi.mock('@lib/rootScope', () => ({
  default: {managers: {appChatsManager: {editChatParticipantRank: mocks.editChatParticipantRank}}}
}));
vi.mock('@components/toast', () => ({toast: mocks.toast}));
vi.mock('@helpers/schedulers', () => ({doubleRaf: () => Promise.resolve()}));
vi.mock('@components/inputField', () => ({
  default: class InputField {
    public container = document.createElement('div');
    public input = document.createElement('div');
    private text = '';

    constructor(public options: {label: string, name: string, maxLength: number}) {
      mocks.fields.push(this);
      this.input.setAttribute('role', 'textbox');
      this.input.setAttribute('aria-label', options.label);
      this.container.append(this.input);
    }

    public get value(): string {
      return this.text;
    }

    public set value(text: string) {
      this.text = text;
    }

    public setOriginalValue(text: string): void {
      this.text = text;
    }
  }
}));
vi.mock('@components/popups/indexTsx', () => {
  const PopupElement = (props: any) => <div role="dialog" class={props.class}>{props.children}</div>;
  PopupElement.Header = (props: any) => <div>{props.children}</div>;
  PopupElement.Title = (props: any) => <h2>{props.title}</h2>;
  PopupElement.Buttons = (props: any) => <div>{props.children}</div>;
  PopupElement.Button = (props: any) => (
    <button data-confirm={props.confirm ? '1' : undefined} onClick={(e) => props.callback?.(e)}>{props.langKey}</button>
  );
  return {
    default: PopupElement,
    createPopup: (factory: () => any) => {
      mocks.popupFactory = factory;
    }
  };
});

import showMemberTagPopup, {getMemberTagActionLangKey, sanitizeMemberTag} from '@components/popups/memberTag';

const CHAT = 500 as ChatId;
const USER = 7 as UserId;

function open(options: Partial<Parameters<typeof showMemberTagPopup>[0]> = {}) {
  const onSaved = vi.fn();
  showMemberTagPopup({chatId: CHAT, userId: USER, currentTag: '', access: 'self', onSaved, ...options});
  const host = document.createElement('div');
  document.body.append(host);
  render(mocks.popupFactory!, host);
  return {host, onSaved};
}

function saveButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('button[data-confirm]')!;
}

beforeEach(() => {
  document.body.replaceChildren();
  mocks.popupFactory = undefined;
  mocks.fields.length = 0;
  mocks.editChatParticipantRank.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
});

describe('what a tag may contain', () => {
  it('drops emoji, trims, and cuts to 16 characters', () => {
    expect(sanitizeMemberTag('  Dean 🎓 ')).toBe('Dean');
    expect(sanitizeMemberTag('x'.repeat(40))).toBe('x'.repeat(16));
    expect(sanitizeMemberTag('🎓')).toBe('');
  });

  it('names the action by whose tag it is and whether one exists', () => {
    expect(getMemberTagActionLangKey({access: 'self', hasTag: false})).toBe('MemberTag.AddMy');
    expect(getMemberTagActionLangKey({access: 'self', hasTag: true})).toBe('MemberTag.EditMy');
    expect(getMemberTagActionLangKey({access: 'other', hasTag: false})).toBe('MemberTag.AddMember');
    expect(getMemberTagActionLangKey({access: 'other', hasTag: true})).toBe('MemberTag.EditMember');
  });
});

describe('saving', () => {
  it('sends the cleaned tag through editChatParticipantRank and reports it', async() => {
    const {host, onSaved} = open({currentTag: 'Old'});
    expect(mocks.fields[0].value).toBe('Old');

    mocks.fields[0].value = '  Dean 🎓 ';
    saveButton(host).click();

    await vi.waitFor(() => expect(mocks.editChatParticipantRank).toHaveBeenCalledTimes(1));
    expect(mocks.editChatParticipantRank).toHaveBeenCalledWith(CHAT, USER, 'Dean');
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith('Dean'));
  });

  it('clearing the field clears the tag: an empty rank is sent', async() => {
    const {host, onSaved} = open({currentTag: ''});

    saveButton(host).click();

    await vi.waitFor(() => expect(mocks.editChatParticipantRank).toHaveBeenCalledWith(CHAT, USER, ''));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(''));
  });

  it('shows the canonical error code of a refusal and keeps the popup open for a correction', async() => {
    mocks.editChatParticipantRank.mockRejectedValue({type: 'PEER_ID_INVALID'});
    const {host, onSaved} = open({currentTag: 'Dean'});

    saveButton(host).click();

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('PEER_ID_INVALID'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('is a titled dialog with a labelled field described by its explanation, and Save and Cancel as buttons', () => {
    const {host} = open({access: 'other', userTitle: 'Alice'});

    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('h2')?.textContent).toBe('MemberTag.Title');
    const input = dialog.querySelector('[role="textbox"]')!;
    expect(input.getAttribute('aria-label')).toBe('MemberTag.Label');
    const describedBy = input.getAttribute('aria-describedby')!;
    expect(describedBy).toBeTruthy();
    expect(dialog.querySelector('#' + describedBy)?.textContent).toBe('MemberTag.AboutMember:Alice');
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Save', 'Cancel']);
    expect(saveButton(host)).toBeTruthy();
  });

  it('explains the own tag differently from another member\'s', () => {
    const {host} = open({access: 'self'});

    const describedBy = host.querySelector('[role="textbox"]')!.getAttribute('aria-describedby')!;
    expect(host.querySelector('#' + describedBy)?.textContent).toBe('MemberTag.AboutSelf');
  });
});
