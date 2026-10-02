import {describe, expect, it, vi} from 'vitest';
import {CallTransitionCoordinator} from '@lib/calls/callTransitionCoordinator';
import deferred from './helpers/deferred';

describe('call transition coordinator', () => {
  it('runs transitions one at a time, in the order they were queued', async() => {
    const coordinator = new CallTransitionCoordinator();
    const created = deferred();
    const joined = deferred();
    const order: string[] = [];

    const createTransition = coordinator.run(async() => {
      order.push('create:start');
      await created.promise;
      order.push('create:end');
    });
    const joinTransition = coordinator.run(async() => {
      order.push('join:start');
      await joined.promise;
      order.push('join:end');
    });

    await vi.waitFor(() => expect(order).toEqual(['create:start']));
    created.resolve();
    await createTransition;
    await vi.waitFor(() => expect(order).toEqual(['create:start', 'create:end', 'join:start']));
    joined.resolve();
    await joinTransition;
    expect(order).toEqual(['create:start', 'create:end', 'join:start', 'join:end']);
  });

  it('hands back what the transition returned', async() => {
    const coordinator = new CallTransitionCoordinator();
    await expect(coordinator.run(async() => 42)).resolves.toBe(42);
  });

  it('keeps going after an aborted transition and reports the abort to its own caller', async() => {
    const coordinator = new CallTransitionCoordinator();
    const error = new Error('transition aborted');

    const aborted = coordinator.run(async() => {
      throw error;
    });
    const next = coordinator.run(async() => 'next');

    await expect(aborted).rejects.toBe(error);
    await expect(next).resolves.toBe('next');
  });
});
