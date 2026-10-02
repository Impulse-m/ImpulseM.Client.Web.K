export const MaxChannelSubscriptions = 32;

export type RealtimeSubscriptionDiff = {
  subscribe: string[],
  unsubscribe: string[]
};

export class RealtimeSubscriptions {
  private readonly userChannel: string;
  private openChannelId: ChatId | undefined;
  private pinnedChannelId: ChatId | undefined;
  private visibleChannelIds = new Set<ChatId>();
  private recentChannelIds: ChatId[] = [];
  private subscribedChannels = new Set<string>();

  constructor(userId: string) {
    this.userChannel = `user:${userId}`;
    this.subscribedChannels.add(this.userChannel);
  }

  public open(channelId: ChatId): RealtimeSubscriptionDiff {
    this.openChannelId = channelId;
    this.touch(channelId);
    return this.reconcile();
  }

  public showDialogs(channelIds: ChatId[]): RealtimeSubscriptionDiff {
    this.visibleChannelIds = new Set(channelIds);
    for(const channelId of channelIds) {
      this.touch(channelId);
    }

    return this.reconcile();
  }

  public close(channelId: ChatId): RealtimeSubscriptionDiff {
    if(this.openChannelId === channelId) {
      this.openChannelId = undefined;
    }

    if(!this.visibleChannelIds.has(channelId)) {
      this.recentChannelIds = this.recentChannelIds.filter((id) => id !== channelId);
    }

    return this.reconcile();
  }

  /**
   * Holds `channel:{id}` for as long as the account is in that channel's group call, outside the
   * MaxChannelSubscriptions window: the call's updateGroupCall / updateGroupCallParticipants ride the
   * channel's shared lane, and a window that rotated it out under a busy dialog list would drop them.
   * Pass undefined to release it; it then competes for a slot like any other lane.
   */
  public pin(channelId: ChatId | undefined): RealtimeSubscriptionDiff {
    this.pinnedChannelId = channelId;
    return this.reconcile();
  }

  public getChannels(): string[] {
    return [...this.subscribedChannels];
  }

  private touch(channelId: ChatId): void {
    this.recentChannelIds = this.recentChannelIds.filter((id) => id !== channelId);
    this.recentChannelIds.push(channelId);
  }

  private reconcile(): RealtimeSubscriptionDiff {
    const rankedChannelIds = this.recentChannelIds.slice().reverse();
    if(this.openChannelId !== undefined) {
      const openIndex = rankedChannelIds.indexOf(this.openChannelId);
      if(openIndex !== -1) {
        rankedChannelIds.splice(openIndex, 1);
      }
      rankedChannelIds.unshift(this.openChannelId);
    }

    const nextChannels = new Set<string>([this.userChannel]);
    for(const channelId of rankedChannelIds.slice(0, MaxChannelSubscriptions)) {
      nextChannels.add(`channel:${channelId}`);
    }

    if(this.pinnedChannelId !== undefined) {
      nextChannels.add(`channel:${this.pinnedChannelId}`);
    }

    const subscribe = [...nextChannels].filter((channel) => !this.subscribedChannels.has(channel));
    const unsubscribe = [...this.subscribedChannels].filter((channel) => !nextChannels.has(channel));
    this.subscribedChannels = nextChannels;

    return {subscribe, unsubscribe};
  }
}
