import replaceContent from '@helpers/dom/replaceContent';
import setInnerHTML from '@helpers/dom/setInnerHTML';
import {GroupCallParticipant} from '@layer';
import {i18n} from '@lib/langPack';
import {GROUP_CALL_PARTICIPANT_MUTED_STATE} from '.';
import {GroupCallParticipantVideoType} from '@components/groupCall/participantVideo';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';
import Icon from '@components/icon';

const className = 'group-call-participant-status';
export default class GroupCallParticipantStatusElement {
  public container: HTMLElement;

  constructor(private withIcons: GroupCallParticipantVideoType[]) {
    this.container = document.createElement('div');
    this.container.classList.add(className + '-container');
  }

  /**
   * @param options.withAccess the participant is on the call's e2e blockchain but absent
   * from the SFU roster — it holds the current shared key without being
   * connected to the media. tdesktop renders the same row as a plain listener
   * with no status icon (`lng_group_call_blockchain_only_status`,
   * calls_group_members_row.cpp:702) and never shows `about` for it.
   * @param options.isSpeaking LiveKit reports the participant as speaking right now. An unmuted participant
   * is "speaking" only while that holds and "listening" while silent; a muted one carries a screen-reader-only
   * "muted" after "listening" so the two silent states do not read the same.
   */
  public setState(
    state: GROUP_CALL_PARTICIPANT_MUTED_STATE,
    participant: GroupCallParticipant,
    options: {withAccess?: boolean, isSpeaking?: boolean} = {}
  ) {
    const {withAccess, isSpeaking} = options;
    const states = GROUP_CALL_PARTICIPANT_MUTED_STATE;
    const icons = withAccess ? [] : this.withIcons.filter((type) => !!participant[type]).map((type) => {
      const iconClassName: Icon = `${type === 'presentation' ? 'listscreenshare_filled' : 'videocamera_filled'}`;
      const i = Icon(iconClassName, className + '-icon', className + '-icon-' + type);
      return i;
    });

    let element2: HTMLElement, actionClassName: string, srState: HTMLElement | undefined;
    if(withAccess) {
      element2 = i18n('VoiceChat.Status.Listening');
      actionClassName = 'is-listening';
    } else if(state === states.MUTED_FOR_ME) {
      element2 = i18n('VoiceChat.Status.MutedForYou');
      actionClassName = 'is-muted';
    } else if(state === states.UNMUTED) {
      element2 = i18n(isSpeaking ? 'VoiceChat.Status.Speaking' : 'VoiceChat.Status.Listening');
      actionClassName = isSpeaking ? 'is-speaking' : 'is-listening';
    } else if(state === states.HAND) {
      element2 = i18n('VoiceChat.Status.WantsSpeak');
      actionClassName = 'is-waiting';
    } else if(participant.about && !icons.length) {
      setInnerHTML(this.container, wrapEmojiText(participant.about));
      return;
    } else {
      element2 = i18n('VoiceChat.Status.Listening');
      actionClassName = 'is-listening';
      if(state === states.MUTED || state === states.MUTED_BY_ADMIN) {
        srState = document.createElement('span');
        srState.classList.add('sr-only');
        srState.append(' ', i18n('VoiceChat.Status.Muted'));
      }
    }

    const span = document.createElement('span');
    span.classList.add(className, actionClassName);
    span.append(...icons, element2);
    srState && span.append(srState);

    replaceContent(this.container, span);
  }
}
