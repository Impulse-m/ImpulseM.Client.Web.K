import {attachClickEvent} from '@helpers/dom/clickEvent';

export type RoundPlaybackTap = {
  arm: (toggle: (e: MouseEvent) => void) => void,
  destroy: () => void
};

export default function attachRoundPlaybackTap(divRound: HTMLElement): RoundPlaybackTap {
  let toggle: (e: MouseEvent) => void;
  let pendingEvent: MouseEvent;

  const detach = attachClickEvent(divRound, (e) => {
    if(toggle) {
      toggle(e);
    } else {
      pendingEvent = e;
    }
  });

  return {
    arm: (newToggle) => {
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
