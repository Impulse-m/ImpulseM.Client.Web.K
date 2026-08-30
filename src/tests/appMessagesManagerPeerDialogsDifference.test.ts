import {describe, expect, it, vi} from 'vitest';

import {AppMessagesManager} from '@appManagers/appMessagesManager';

describe('AppMessagesManager peer dialog reload', () => {
  it('hands a pts mismatch to getDifference without reissuing getPeerDialogs', async() => {
    vi.useFakeTimers();
    try {
      const manager = new AppMessagesManager();
      const invokeApi = vi.fn()
        .mockResolvedValueOnce({dialogs: [], messages: [], state: {pts: 20}, users: [], chats: []})
        .mockResolvedValueOnce({dialogs: [], messages: [], state: {pts: 10}, users: [], chats: []});
      const forceGetDifference = vi.fn().mockResolvedValue(undefined);
      const log = Object.assign(vi.fn(), {
        bindPrefix: () => log,
        warn: vi.fn()
      });

      Object.assign(manager as any, {
        apiManager: {invokeApi},
        apiUpdatesManager: {
          forceGetDifference,
          updatesState: {pts: 10}
        },
        dialogsStorage: {applyDialogs: vi.fn()},
        log,
        reloadConversationsPeers: new Map()
      });

      const reload = manager.reloadConversation();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      await reload;

      expect(invokeApi.mock.calls.filter(([method]) => method === 'messages.getPeerDialogs')).toHaveLength(1);
      expect(forceGetDifference).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
