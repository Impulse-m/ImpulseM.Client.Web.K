import {expect, Page} from '@playwright/test';
import {test} from './workerContext';
import {openStory, preparePopupSandbox} from './popupSandbox.helpers';

const STORY = 'call/groupCall';

type ContainerGeometry = {
  topRadii: string[],
  bottomRadii: string[],
  bottom: number,
  viewportHeight: number
};

type ScreenShare = {
  peerId: number,
  trackId: string
};

async function openGroupCall(page: Page) {
  await preparePopupSandbox(page, false);
  expect(await openStory(page, STORY), 'the video chat story opens without throwing').toBeNull();
  const container = page.locator('.popup-group-call.active .group-call');
  await expect(container).toBeVisible();
  // the panel slides into place: measure it once it has stopped
  await expect.poll(() => container.evaluate((element) => getComputedStyle(element).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
}

function readContainerGeometry(page: Page): Promise<ContainerGeometry> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.popup-group-call.active .group-call');
    const style = getComputedStyle(container);
    return {
      topRadii: [style.borderTopLeftRadius, style.borderTopRightRadius],
      bottomRadii: [style.borderBottomLeftRadius, style.borderBottomRightRadius],
      bottom: container.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight
    };
  });
}

/**
 * Two remote participants start sharing their screens, through the path a real call takes: the row
 * arrives with `presentation` set (constructor/groupCallParticipant.md:138-142), then LiveKit hands
 * over the screen track under the presentation identity `u{peer}.{audio_source}.p`.
 */
function startTwoRemoteScreenShares(page: Page): Promise<ScreenShare[]> {
  return page.evaluate(async() => {
    const controllerPath = '/src/lib/calls/groupCallsController.ts';
    const rootScopePath = '/src/lib/rootScope.ts';
    const [{default: groupCallsController}, {default: rootScope}] = await Promise.all([
      import(/* @vite-ignore */ controllerPath),
      import(/* @vite-ignore */ rootScopePath)
    ]);
    const instance = groupCallsController.groupCall;
    // the story's stand-in stream manager has no mixer to take remote media
    instance.connections.main.streamManager.addTrack = () => {};

    const participants = [...(await instance.participants).values()].filter((participant: any) => !participant.pFlags.self);
    return participants.map((participant: any, index: number) => {
      const audioSource = 1000 + index;
      const endpoint = `u${participant.peer.user_id}.${audioSource}.p`;
      participant.presentation = {
        _: 'groupCallParticipantVideo',
        pFlags: {},
        endpoint,
        source_groups: [],
        audio_source: audioSource
      };
      // what groupCallsController.construct wires up in the app and the sandbox never constructs
      instance.onParticipantUpdate(participant);
      rootScope.dispatchEvent('group_call_participant', {groupCallId: instance.id, participant});

      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      context.fillStyle = index ? '#3366cc' : '#cc6633';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const track = canvas.captureStream(5).getVideoTracks()[0];
      instance.mediaRouter.onRemoteTrack({identity: endpoint, sid: `screen-${index}`, source: 'screen', track, muted: false});

      return {peerId: participant.peer.user_id, trackId: track.id};
    });
  });
}

test.describe('group call popup', () => {
  test('a movable video chat keeps all four corners rounded', async({page}) => {
    await page.setViewportSize({width: 1280, height: 800});
    await openGroupCall(page);

    const geometry = await readContainerGeometry(page);
    expect(geometry.topRadii[0], 'the panel has rounded top corners').not.toBe('0px');
    expect(
      geometry.bottomRadii,
      'a floating video chat panel rounds its bottom corners like its top ones; square ones belong to the touch sheet glued to the screen edge'
    ).toEqual(geometry.topRadii);
  });

  test.describe('on a touch screen', () => {
    // the shared worker context is built from the project's options, so a touch screen needs its own
    test.use({hasTouch: true, freshContext: true});

    test('the video chat is a sheet whose square bottom corners sit on the screen edge', async({page}) => {
      await page.setViewportSize({width: 1280, height: 800});
      await openGroupCall(page);

      const geometry = await readContainerGeometry(page);
      expect(geometry.topRadii[0], 'the sheet has rounded top corners').not.toBe('0px');
      expect(geometry.bottomRadii, 'the sheet has square bottom corners').toEqual(['0px', '0px']);
      expect(Math.round(geometry.bottom), 'the square corners touch the bottom of the screen').toBe(geometry.viewportHeight);
    });
  });

  test('every screen sharer is named on their tile and marked in the list without hovering', async({page}) => {
    await page.setViewportSize({width: 1280, height: 800});
    await openGroupCall(page);
    await page.mouse.move(0, 0);

    const screenShares = await startTwoRemoteScreenShares(page);
    expect(screenShares, 'both remote participants share their screens').toHaveLength(2);

    const list = page.locator('.popup-group-call.active .group-call-participants .chatlist');
    const nameByTrackId = new Map<string, string>();
    for(const {peerId, trackId} of screenShares) {
      const row = list.locator(`.group-call-participant[data-peer-id="${peerId}"]`);
      await expect(
        row.locator('.group-call-participant-status-icon-presentation'),
        `the list row of ${peerId} carries the screen-sharing status`
      ).toBeVisible();
      nameByTrackId.set(trackId, await row.locator('.peer-title').first().textContent());
    }

    const screenTiles = page.locator('.popup-group-call.active .popup-body .group-call-participant-video-container')
    .filter({has: page.locator('.group-call-participant-status-icon-presentation')});
    await expect(screenTiles.first()).toBeVisible();

    const tiles = await screenTiles.evaluateAll((elements) => elements
    .filter((element) => getComputedStyle(element).display !== 'none')
    .map((element) => {
      const info = element.querySelector<HTMLElement>('.group-call-participant-video-info');
      const stream = element.querySelector('video').srcObject as MediaStream;
      return {
        trackId: stream.getVideoTracks()[0].id,
        name: info.querySelector('.peer-title').textContent,
        opacity: getComputedStyle(info).opacity
      };
    }));
    expect(tiles.length, 'a screen tile is on screen').toBeGreaterThan(0);

    for(const tile of tiles) {
      expect(tile.name, 'the tile is labelled with the name of the participant whose screen it plays').toBe(nameByTrackId.get(tile.trackId));
      expect(tile.opacity, `the label "${tile.name}" is visible without hovering the tile`).toBe('1');
    }
  });
});
