import {attachClickEvent} from '@helpers/dom/clickEvent';
import {getLogger} from '@lib/impulseLogger';


const log = getLogger('ROUND-TAP');

export type RoundPlaybackTap = {
  arm: (toggle: (e: MouseEvent) => void) => void,
  destroy: () => void
};

export default function attachRoundPlaybackTap(divRound: HTMLElement): RoundPlaybackTap {
  let toggle: (e: MouseEvent) => void;
  let pendingEvent: MouseEvent;

  const detach = attachClickEvent(divRound, (e) => {
    log.info('tap', {mid: divRound.dataset.mid, armed: !!toggle, hadPending: !!pendingEvent});
    if(toggle) {
      toggle(e);
    } else {
      pendingEvent = e;
    }
  });

  return {
    arm: (newToggle) => {
      log.info('arm', {mid: divRound.dataset.mid, replacing: !!toggle, replayingPending: !!pendingEvent});
      toggle = newToggle;
      if(pendingEvent) {
        const event = pendingEvent;
        pendingEvent = undefined;
        toggle(event);
      }
    },
    destroy: () => {
      detach();
      toggle = undefined;
      pendingEvent = undefined;
    }
  };
}
