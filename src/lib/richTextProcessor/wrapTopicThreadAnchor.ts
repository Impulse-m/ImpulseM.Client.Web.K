import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';
import wrapImpulseMUrlToAnchor from '@lib/richTextProcessor/wrapImpulseMUrlToAnchor';

type WrapTopicThreadAnchorArgs = {
  peerId: PeerId;
  threadId: number;
  lastMsgId: number;
};

export default function wrapTopicThreadAnchor({peerId, threadId, lastMsgId}: WrapTopicThreadAnchorArgs) {
  return wrapImpulseMUrlToAnchor(
    't.me/c/' +
    peerId.toChatId() +
    (threadId ? '/' + getServerMessageId(threadId) : '') +
    (lastMsgId ? '/' + getServerMessageId(lastMsgId) : '')
  );
}
