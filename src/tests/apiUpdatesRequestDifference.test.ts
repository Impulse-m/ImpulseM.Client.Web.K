import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';

/*
 * A lane whose pushed update could not be dispatched asks the manager for the difference of that lane: the inbox's through
 * updatesTooLong, a channel's through updates.getChannelDifference from the channel's own pts.
 */

const CHANNEL_ID: number = 42;
const CHANNEL_PTS: number = 7;

function makeLog() {
  const makeLogger = () => Object.assign(vi.fn(), {warn: vi.fn(), error: vi.fn()});
  return Object.assign(makeLogger(), {bindPrefix: makeLogger});
}

function managerWithStubs() {
  const manager = new ApiUpdatesManager() as any;
  const invokeApi = vi.fn(() => new Promise<never>(() => {}));
  Object.assign(manager, {
    log: makeLog(),
    apiManager: {invokeApi},
    appChatsManager: {
      getChannelInput: vi.fn(() => ({_: 'inputChannel', channel_id: CHANNEL_ID, access_hash: 'hash'}))
    },
    rootScope: {dispatchEvent: vi.fn()}
  });
  return {manager, invokeApi};
}

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void) => setTimeout(resolve, 0));
}

describe('a recovery request of the inbox lane', () => {
  it('asks the inbox for its difference through updates.getDifference', async() => {
    const {manager, invokeApi} = managerWithStubs();

    manager.requestDifference(undefined);
    await settled();

    expect(
      invokeApi,
      'an inbox recovery is the updatesTooLong answer: a getDifference of the inbox state'
    ).toHaveBeenCalledWith('updates.getDifference', expect.anything(), expect.anything());
  });
});

describe('a recovery request of a channel lane', () => {
  it('asks the channel for its own difference from the pts the channel holds', async() => {
    const {manager, invokeApi} = managerWithStubs();
    manager.addChannelState(CHANNEL_ID, CHANNEL_PTS);

    manager.requestDifference(CHANNEL_ID);
    await settled();

    expect(
      invokeApi,
      'a channel recovery asks updates.getChannelDifference for that channel, from its own pts, not the inbox'
    ).toHaveBeenCalledWith('updates.getChannelDifference', expect.objectContaining({pts: CHANNEL_PTS}), expect.anything());
    expect(invokeApi, 'the channel recovery does not ask for the inbox difference').not.toHaveBeenCalledWith(
      'updates.getDifference',
      expect.anything(),
      expect.anything()
    );
  });
});
