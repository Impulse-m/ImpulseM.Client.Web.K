import {readFileSync} from 'fs';

import {describe, expect, it} from 'vitest';

/**
 * The connection status must be filed under the key the reader looks it up by.
 *
 * There is no runtime moment at which this can be asserted cheaply — the producer runs inside a
 * manager's construction, behind a restored session and an account lookup, and the reader is a DOM
 * component on a two-second timer. What can be asserted is the thing that actually broke: the two
 * halves used different keys.
 *
 * rootScope files each status under `status.name`. ConnectionStatusComponent reads
 * `'NET-' + baseDcId`, which is the name MTPNetworker gives its client connection. Our gateway
 * reporter sent a readable 'impulse-gateway' instead. Both sides then worked perfectly: dispatched,
 * stored, never found. Nothing errored. The chat-list search read "Waiting for network" for the
 * life of the tab, and `hadConnect` never armed, so a reconnect never ran forceGetDifference —
 * the caption was only the visible half.
 *
 * This is the shape that keeps costing this project: a producer and a consumer that agree on
 * everything except the one string joining them, with no assertion anywhere that compares the two.
 */
describe('the gateway files its connection status where the component reads it', () => {
  const producer = readFileSync('src/lib/appManagers/apiManager.ts', 'utf8');
  const consumer = readFileSync('src/components/connectionStatus.ts', 'utf8');
  const networker = readFileSync('src/lib/mtproto/networker.ts', 'utf8');
  const PREFIX = 'NET-';

  it('uses the prefix the component looks up', () => {
    expect(
      consumer.includes(`connectionStatus[${String.fromCharCode(39)}${PREFIX}`),
      'connectionStatus.ts no longer looks the status up by the ' + PREFIX + ' prefix, so this ' +
      'guard is comparing the producer against a convention nobody reads any more. Re-read the ' +
      'component and re-derive the key before trusting anything below.'
    ).toBe(true);

    expect(
      networker.includes(`${String.fromCharCode(39)}${PREFIX}${String.fromCharCode(39)} + this.dcId`),
      'MTPNetworker no longer names itself with the ' + PREFIX + ' prefix; the convention this ' +
      'guard pins has moved and the producer must follow it, not this test.'
    ).toBe(true);

    expect(
      producer.includes(`name: ${String.fromCharCode(39)}${PREFIX}${String.fromCharCode(39)} + dcId`),
      'the gateway status is not filed under the ' + PREFIX + ' key. It will be dispatched, it ' +
      'will be stored, and it will never be found — which shows up as "Waiting for network" ' +
      'forever in the chat list, and as reconnects that never run forceGetDifference.'
    ).toBe(true);
  });

  it('never files it under a human-readable name again', () => {
    expect(
      /name:\s*['"]impulse-gateway['"]/.test(producer),
      'a readable name here is a silent break: it reads like a label and is in fact the lookup ' +
      'key. Whoever finds "NET-" + dcId ugly is looking at the join between two files, not at a ' +
      'caption.'
    ).toBe(false);
  });
});
