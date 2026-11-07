import {liveLane} from './lane';
import {expect, test} from './pair';

test.skip(!liveLane.enabled, liveLane.skipReason);

// #1185: a run of messages deleted for everyone in the middle of a basic group's history. The recipient never read
// the group, so the client opens it at the first unread message, the oldest live one, and pages down by scrolling;
// each page asks at most 40 rows (bubbles.ts getHistory: min(40, height / 40), then max(35, that)). The server's walk
// reads 8 windows of limit + 8 index rows a page (344 rows at limit 35), so a dead run longer than that ends a page
// empty, and the client stops paging there: the newer live messages are unreachable.
const olderMessageCount: number = 5;
const revokedMessageCount: number = 450;
const newerMessageCount: number = 30;
const revokeBatchSize: number = 100;
const seedTimeoutMs: number = 1_200_000;
const chatAppearTimeoutMs: number = 90_000;
const renderTimeoutMs: number = 90_000;
const scrollDownAttempts: number = 30;
const scrollSettleMs: number = 1_500;

test('scrolling down a basic group from its first unread message past a run revoked for everyone reaches the newer live messages', async({pair}, testInfo) => {
  testInfo.setTimeout(seedTimeoutMs);

  const {sender, recipient} = pair;
  const recipientUserId: number = Number(await recipient.ownPeerId());
  const nonce: string = Date.now().toString(36);
  const title: string = `dead-run-${nonce}`;
  const olderTexts: string[] = Array.from(
    {length: olderMessageCount},
    (_: unknown, index: number): string => `dead-run-older-${nonce}-${index + 1}`
  );
  const newerTexts: string[] = Array.from(
    {length: newerMessageCount},
    (_: unknown, index: number): string => `dead-run-newer-${nonce}-${index + 1}`
  );

  const groupId: number = await sender.page.evaluate(async({userId, groupTitle, nonceValue, older, newer, revokedCount, batchSize}) => {
    const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    const {randomLong} = await dynamicImport('/src/helpers/random.ts');

    const w = window as any;
    const api = w.rootScope.managers.apiManager;

    // Every manager call crosses to the worker and answers a promise: await it, or the request carries a promise
    // the worker's structured clone refuses.
    const invitee: any = await w.rootScope.managers.appUsersManager.getUserInput(userId);
    const created: any = await api.invokeApi('messages.createChat', {
      users: [invitee],
      title: groupTitle
    });
    const chatId: number = created.updates.chats[0].id;
    const peer: any = {_: 'inputPeerChat', chat_id: chatId};

    const sendText = async(text: string): Promise<number> => {
      const updates: any = await api.invokeApi('messages.sendMessage', {
        peer,
        message: text,
        random_id: randomLong()
      });
      if(updates?._ !== 'updates') {
        throw new Error(`messages.sendMessage answered ${updates?._}, not updates`);
      }

      const idUpdate: any = updates.updates.find((update: any) => update._ === 'updateMessageID');
      if(!idUpdate) {
        throw new Error(`messages.sendMessage for "${text}" carried no updateMessageID`);
      }

      return idUpdate.id;
    };

    for(const text of older) {
      await sendText(text);
    }

    const revokedIds: number[] = [];
    for(let index: number = 0; index < revokedCount; index++) {
      revokedIds.push(await sendText(`dead-run-revoked-${nonceValue}-${index + 1}`));
    }

    for(let start: number = 0; start < revokedIds.length; start += batchSize) {
      await api.invokeApi('messages.deleteMessages', {
        revoke: true,
        id: revokedIds.slice(start, start + batchSize)
      });
    }

    for(const text of newer) {
      await sendText(text);
    }

    return chatId;
  }, {
    userId: recipientUserId,
    groupTitle: title,
    nonceValue: nonce,
    older: olderTexts,
    newer: newerTexts,
    revokedCount: revokedMessageCount,
    batchSize: revokeBatchSize
  });

  await recipient.page.waitForFunction((chatIdValue: number) => {
    return !!(window as any).rootScope.managers.appChatsManager.getChat(chatIdValue);
  }, groupId, {timeout: chatAppearTimeoutMs});

  // The recipient was online while the group was seeded, so every message reached it over the update socket and
  // sits in its worker's memory. A reload drops that memory: the chat's history now comes from messages.getHistory.
  await recipient.page.reload({waitUntil: 'domcontentloaded'});
  await recipient.waitForImReady();

  await recipient.page.evaluate((chatIdValue: number) => {
    return (window as any).appImManager.setInnerPeer({peerId: chatIdValue.toPeerId(true)});
  }, groupId);

  const unreadCount: number = await recipient.page.evaluate(async(chatIdValue: number) => {
    const w = window as any;
    const answer: any = await w.rootScope.managers.apiManager.invokeApi('messages.getPeerDialogs', {
      peers: [{_: 'inputDialogPeer', peer: {_: 'inputPeerChat', chat_id: chatIdValue}}]
    });
    return answer.dialogs[0].unread_count;
  }, groupId);
  expect.soft(
    unreadCount,
    'the dialog counts every live message the recipient has not read, and none of the run revoked for everyone'
  ).toBe(olderMessageCount + newerMessageCount);

  for(const text of olderTexts) {
    await expect(
      recipient.page.locator('.bubble[data-mid]:not(.is-sending)', {hasText: text}).first(),
      `the group opens at its first unread message, so "${text}" renders first`
    ).toBeVisible({timeout: renderTimeoutMs});
  }

  const newestNewer = recipient.page.locator('.bubble[data-mid]:not(.is-sending)', {hasText: newerTexts[newerTexts.length - 1]}).first();
  for(let attempt: number = 0; attempt < scrollDownAttempts && !(await newestNewer.isVisible()); attempt++) {
    await recipient.page.evaluate(() => {
      const scrollable: HTMLElement | null = document.querySelector('.chat.tabs-tab.active .bubbles .scrollable');
      if(scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
      }
    });
    await recipient.page.waitForTimeout(scrollSettleMs);
  }

  for(const text of newerTexts) {
    await expect(
      recipient.page.locator('.bubble[data-mid]:not(.is-sending)', {hasText: text}).first(),
      `scrolling down must reach "${text}": the live messages above a run revoked for everyone are served, and the ` +
      'page that crosses the run is not empty'
    ).toBeVisible({timeout: renderTimeoutMs});
  }
});
