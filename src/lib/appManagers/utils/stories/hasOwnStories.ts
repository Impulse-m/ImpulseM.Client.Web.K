import apiManagerProxy from '@lib/apiManagerProxy';
import rootScope from '@lib/rootScope';

export default function hasOwnStories(): boolean {
  return !!apiManagerProxy.getUser(rootScope.myId)?.stories_max_id;
}
