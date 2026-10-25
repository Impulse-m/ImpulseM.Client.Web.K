import type {PersonaSession} from './personaSession';

/*
 * A document sent from one persona's open dialog, and the digest of the same document as the recipient downloads it.
 */

export async function sendDocument(sender: PersonaSession, payload: Uint8Array, name: string): Promise<void> {
  await sender.page.evaluate(async({bytes, documentName}) => {
    const w = window as any;
    const chat = w.appImManager.chat;
    if(!chat?.peerId) {
      throw new Error('the document send was requested with no open dialog');
    }

    const file = new File([Uint8Array.from(bytes)], documentName, {type: 'application/octet-stream'});
    await w.rootScope.managers.appMessagesManager.sendFile({
      ...chat.getMessageSendingParams(),
      file,
      isMedia: false,
      clearDraft: true
    });
  }, {bytes: Array.from(payload), documentName: name});
}

export async function downloadedDigest(recipient: PersonaSession, name: string): Promise<{size: number, sha256: string}> {
  return recipient.page.evaluate(async(documentName: string) => {
    const w = window as any;
    const chat = w.appImManager.chat;
    const history = await w.rootScope.managers.appMessagesManager.getHistory({peerId: chat.peerId, limit: 20});
    const messages: any[] = await Promise.all((history?.history ?? []).map((mid: number) =>
      w.rootScope.managers.appMessagesManager.getMessageByPeer(chat.peerId, mid)
    ));
    const message = messages.find((entry: any) => entry?.media?.document?.file_name === documentName);
    if(!message) {
      throw new Error(`no document named ${documentName} is in the recipient's dialog`);
    }

    const blob: Blob = await w.rootScope.managers.appDocsManager.downloadDoc(message.media.document);
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (byte: number): string => byte.toString(16).padStart(2, '0')).join('');
    return {size: blob.size, sha256};
  }, name);
}
