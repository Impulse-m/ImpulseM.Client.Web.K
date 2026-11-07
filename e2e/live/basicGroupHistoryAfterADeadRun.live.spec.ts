import {liveLane} from './lane';
import {expect, test} from './pair';

test.skip(!liveLane.enabled, liveLane.skipReason);

const liveMessageCount: number = 5;
const revokedMessageCount: number = 300;
const revokeBatchSize: number = 100;
const seedTimeoutMs: number = 600_000;
const chatAppearTimeoutMs: number = 90_000;
const renderTimeoutMs: number = 90_000;

test('a run of messages revoked for everyone above a basic group\'s live messages still shows those live messages to the other member', async({pair}, testInfo) => {
  testInfo.setTimeout(seedTimeoutMs);

  const {sender, recipient} = pair;
  const recipientUserId: number = Number(await recipient.ownPeerId());
  const nonce: string = Date.now().toString(36);
  const title: string = `dead-run-${nonce}`;
  const liveTexts: string[] = Array.from(
    {length: liveMessageCount},
    (_: unknown, index: number): string => `dead-run-live-${nonce}-${index + 1}`
  );

  const groupId: number = await sender.page.evaluate(async({userId, groupTitle, nonceValue, texts, revokedCount, batchSize}) => {
    const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    const {randomLong} = await dynamicImport('/src/helpers/random.ts');

    const w = window as any;
    const api = w.rootScope.managers.apiManager;

    const created: any = await api.invokeApi('messages.createChat', {
      users: [w.rootScope.managers.appUsersManager.getUserInput(userId)],
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

    for(const text of texts) {
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

    return chatId;
  }, {
    userId: recipientUserId,
    groupTitle: title,
    nonceValue: nonce,
    texts: liveTexts,
    revokedCount: revokedMessageCount,
    batchSize: revokeBatchSize
  });

  await recipient.page.waitForFunction((chatIdValue: number) => {
    return !!(window as any).rootScope.managers.appChatsManager.getChat(chatIdValue);
  }, groupId, {timeout: chatAppearTimeoutMs});

  await recipient.page.evaluate((chatIdValue: number) => {
    return (window as any).appImManager.setInnerPeer({peerId: chatIdValue.toPeerId(true)});
  }, groupId);

  for(const text of liveTexts) {
    await expect(
      recipient.page.locator('.bubble[data-mid]:not(.is-sending)', {hasText: text}).first(),
      `the other member's chat must render "${text}" from its own history load: the live messages below a run of revoked messages are served`
    ).toBeVisible({timeout: renderTimeoutMs});
  }
});
