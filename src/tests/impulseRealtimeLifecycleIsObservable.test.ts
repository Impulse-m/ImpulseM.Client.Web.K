import {readFileSync} from 'fs';

import {describe, expect, it} from 'vitest';

/**
 * The realtime lane must record how it dies, not only that it was asked to live.
 *
 * This is a source guard rather than a behavioural test, deliberately. The defect it pins was not a
 * wrong value — it was an ABSENCE, and an absence has no runtime moment at which to assert. For
 * ninety minutes of a real session the only trace this module left was five lines reading "Realtime
 * connected", written immediately after calling `connect()` and `subscribe()`. Both are
 * asynchronous and return nothing, so the line recorded an intention as an outcome: it appeared
 * whether or not a socket was ever established. Meanwhile the server's subscribe proxy had been
 * called twice in forty minutes, and not one line anywhere said a connection had dropped, why, or
 * with what code.
 *
 * So the logs agreed with themselves and described something that had not happened, and the single
 * question worth asking — what is killing the connection — had no evidence to answer it from. That
 * is what this guard protects: whoever deletes one of these handlers takes the answer away again,
 * and the next person to look will see a quiet log and conclude the lane is healthy.
 */
const QUOTE = String.fromCharCode(39);


describe('the realtime lane logs its own lifecycle', () => {
  const source = readFileSync('src/lib/impulse/realtime.ts', 'utf8');

  /**
   * Both edges of both state machines. A live socket carrying no subscription delivers nothing and
   * looks exactly like a dead socket unless the two are recorded apart.
   */
  const required = [
    {owner: 'centrifuge', event: 'connecting', why: 'a reconnect loop is invisible without the attempts'},
    {owner: 'centrifuge', event: 'connected', why: 'the only line that may claim a socket exists'},
    {owner: 'centrifuge', event: 'disconnected', why: 'the drop, with the code and reason Centrifugo gives — the whole question'},
    {owner: 'sub', event: 'subscribing', why: 'a subscription retrying under a live socket is otherwise silent'},
    {owner: 'sub', event: 'subscribed', why: 'the only line that may claim updates can now arrive'},
    {owner: 'sub', event: 'unsubscribed', why: 'a channel dropped under a live socket delivers nothing and reports nothing'}
  ];

  it.each(required)('handles $owner.on($event)', ({owner, event, why}) => {
    const handler = `${owner}.on(${QUOTE}${event}${QUOTE}`;

    expect(
      source.includes(handler),
      `src/lib/impulse/realtime.ts no longer registers ${handler}). Without it: ${why}.\n\n` +
      'Diagnosing this lane from logs is the only tool there is — it runs in a worker, in the ' +
      'user\'s browser, and nobody can attach a debugger to it after the fact.'
    ).toBe(true);
  });

  it('never claims a connection from the call site instead of the event', () => {
    const spinUpTail = source.slice(source.indexOf('sub.subscribe();'));

    expect(
      /logger\.info\('Realtime connected'/.test(spinUpTail),
      'a "Realtime connected" line placed after sub.subscribe()/centrifuge.connect() is the exact ' +
      'defect this file was corrected for: those calls are asynchronous and return nothing, so the ' +
      'line fires whether or not a socket is ever established. It is worse than no log, because it ' +
      'reads as evidence. Claim the connection from the connected event or not at all.'
    ).toBe(false);
  });
});
