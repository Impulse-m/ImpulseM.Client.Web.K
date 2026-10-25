import {describe, expect, it, vi} from 'vitest';

import {Drainable} from '@lib/impulse/fleet/drainable';

describe('Drainable', () => {
  it('closes at once when it is retired while idle, and only once', () => {
    const onClose: () => void = vi.fn();
    const drain: Drainable = new Drainable(onClose);

    drain.retire();
    drain.retire();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never closes before it is retired, however many calls settle', () => {
    const onClose: () => void = vi.fn();
    const drain: Drainable = new Drainable(onClose);

    drain.begin();
    drain.end();
    drain.begin();
    drain.end();

    expect(onClose).not.toHaveBeenCalled();
    expect(drain.isRetired()).toBe(false);
  });

  it('closes only when the last call in flight settles after retire', () => {
    const onClose: () => void = vi.fn();
    const drain: Drainable = new Drainable(onClose);

    drain.begin();
    drain.begin();
    drain.retire();
    expect(onClose).not.toHaveBeenCalled();

    drain.end();
    expect(onClose).not.toHaveBeenCalled();

    drain.end();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a call that begins after retire still closes the drain after its end, once', () => {
    const onClose: () => void = vi.fn();
    const drain: Drainable = new Drainable(onClose);

    drain.begin();
    drain.retire();
    drain.begin();
    drain.end();
    expect(onClose).not.toHaveBeenCalled();

    drain.end();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
