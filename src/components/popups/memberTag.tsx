import {createSignal} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import InputField from '@components/inputField';
import {toast} from '@components/toast';
import {i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import emojiRegExp from '@vendor/emoji/regex';
import {doubleRaf} from '@helpers/schedulers';
import {MEMBER_TAG_MAX_LENGTH, MemberTagAccess} from '@appManagers/utils/chats/memberTagRights';

const EMOJI_REG_EXP = new RegExp(emojiRegExp, 'g');

/** api/rank.md: a tag has no emojis, so none is ever offered to the server. */
export function sanitizeMemberTag(text: string): string {
  return text.replace(EMOJI_REG_EXP, '').trim().slice(0, MEMBER_TAG_MAX_LENGTH);
}

export function getMemberTagActionLangKey(options: {access: MemberTagAccess, hasTag: boolean}): LangPackKey {
  if(options.access === 'self') {
    return options.hasTag ? 'MemberTag.EditMy' : 'MemberTag.AddMy';
  }

  return options.hasTag ? 'MemberTag.EditMember' : 'MemberTag.AddMember';
}

/**
 * Sets or clears a member's tag (messages.editChatParticipantRank). The server's own code is what the user is shown
 * when it refuses, as the official clients do, and the popup stays open so the tag can be corrected.
 */
export default function showMemberTagPopup(options: {
  chatId: ChatId,
  userId: UserId,
  currentTag: string,
  access: MemberTagAccess,
  userTitle?: Node | string,
  onSaved?: (tag: string) => void
}): void {
  createPopup(() => {
    const [isSaving, setSaving] = createSignal(false);
    const inputField = new InputField({
      label: 'MemberTag.Label',
      name: 'member-tag',
      maxLength: MEMBER_TAG_MAX_LENGTH
    });
    inputField.setOriginalValue(options.currentTag, true);
    // the field holds no emoji: whatever is typed or pasted is cleaned on the way in
    inputField.input.addEventListener('input', () => {
      const cleaned = sanitizeMemberTag(inputField.value);
      if(cleaned !== inputField.value.trim().slice(0, MEMBER_TAG_MAX_LENGTH)) {
        inputField.value = cleaned;
      }
    });

    const aboutId = 'member-tag-about-' + options.chatId + '-' + options.userId;
    inputField.input.setAttribute('aria-describedby', aboutId);
    doubleRaf().then(() => inputField.input.focus());

    const save = async(): Promise<boolean> => {
      if(isSaving()) {
        return false;
      }

      const tag = sanitizeMemberTag(inputField.value);
      setSaving(true);
      try {
        await rootScope.managers.appChatsManager.editChatParticipantRank(options.chatId, options.userId, tag);
      } catch(err) {
        setSaving(false);
        toast(String((err as ApiError)?.type ?? err));
        return false;
      }

      options.onSaved?.(tag);
      return true;
    };

    return (
      <PopupElement class="popup-member-tag" closable>
        <PopupElement.Header>
          <PopupElement.Title title="MemberTag.Title" />
        </PopupElement.Header>
        <div class="popup-member-tag-body">
          {inputField.container}
          <p class="popup-description" id={aboutId}>
            {options.access === 'self' ?
              i18n('MemberTag.AboutSelf') :
              i18n('MemberTag.AboutMember', [options.userTitle ?? ''])}
          </p>
        </div>
        <PopupElement.Buttons>
          <PopupElement.Button langKey="Save" confirm callback={save} />
          <PopupElement.Button langKey="Cancel" cancel />
        </PopupElement.Buttons>
      </PopupElement>
    );
  });
}
