import {readFileSync, readdirSync, type Dirent} from 'fs';
import {join} from 'path';

import {describe, expect, it} from 'vitest';


/*
 * Issue #141. One error class, one code, two entirely different meanings.
 *
 * whenImpulseSessionReady() rejects with an ImpulseSessionRestoreError in two situations that
 * have nothing to do with each other: the DEV-only bypass, raised when the gate is asked before
 * any restore was started, and a restore that genuinely failed. Both carry
 * IMPULSE_SESSION_RESTORE_FAILED, and under vitest the bypass is always armed -- so a test that
 * asserts the gate's rejection by name and code alone is answered by whichever one it happens to
 * reach, and impulseSessionGate.test.ts reached the bypass for as long as it existed. It would
 * have stayed green with the restore-failure path deleted outright.
 *
 * Only the message separates them. This guard fails when a test names the gate's error without
 * naming which of the two it means, and it fails just as loudly if its own premise stops holding
 * -- if the bypass is ever removed, or the two messages collapse into one, the right move is to
 * delete this guard deliberately, not to loosen it.
 */

const SESSION_SOURCE_PATH = 'src/lib/impulse/session.ts';
const TEST_ROOTS = ['src/tests', 'e2e'];
const SELF = 'impulseSessionGateRejectionsSayWhichOne.test.ts';
const TEST_FILE = /\.(test|spec)\.tsx?$/;

const ERROR_NAME = 'ImpulseSessionRestoreError';
const ERROR_CODE = 'IMPULSE_SESSION_RESTORE_FAILED';

/*
 * What an assertion on the gate's identity actually looks like in source: the name or the code
 * written as a string literal, or the class itself imported so it can be reached by instanceof.
 * Prose names it too -- this very file does -- and prose asserts nothing, so a bare mention is
 * deliberately not enough to make a file a candidate.
 */
const QUOTED_IDENTITY = new RegExp(`(['"])(?:${ERROR_NAME}|${ERROR_CODE})\\1`);
const IMPORTED_CLASS = new RegExp(`import\\s*\\{[^}]*\\b${ERROR_NAME}\\b[^}]*\\}`);

const PREMISE_GONE =
  `${SESSION_SOURCE_PATH} no longer raises ${ERROR_NAME} with two distinct messages, so there is ` +
  'no longer a pair for a test to confuse. Either the DEV bypass was removed -- in which case ' +
  'delete this guard on purpose -- or the two rejections now say the same thing, which is worse ' +
  'than the defect it was written for: nothing at all would tell a bypassed gate apart from a ' +
  'restore that actually failed.';

const NOTHING_SWEPT =
  'This guard found no test that asserts on the session gate error at all. The gate rejecting on ' +
  'a genuine failure is what stops an unauthenticated boot wave (#137); a guard that sweeps an ' +
  'empty set is the same kind of always-green assertion it exists to catch, so it fails rather ' +
  'than report success over nothing.';

const NAME_AND_CODE_DO_NOT_DISCRIMINATE =
  'The DEV bypass must still answer an un-started gate with the shared name and code and its own ' +
  'message. That is the whole hazard: if this stops holding the guard below is pinning a source ' +
  'convention nobody can violate any more, and it must be re-derived rather than trusted.';


function testFilesUnder(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, {withFileTypes: true});
  } catch(_) {
    // A root that does not exist yet is not a finding; an empty sweep overall is, below.
    return [];
  }

  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if(entry.isDirectory()) {
      return testFilesUnder(path);
    }

    return TEST_FILE.test(entry.name) && entry.name !== SELF ? [path] : [];
  });
}


/** Every message literal the gate's error is constructed with, read out of the source itself. */
function rejectionMessages(source: string): string[] {
  const pattern = new RegExp(`new ${ERROR_NAME}\\(\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'g');
  return Array.from(source.matchAll(pattern), (match) => match[2]);
}


describe('a test asserting the session gate error must say which one it means', () => {
  const messages = rejectionMessages(readFileSync(SESSION_SOURCE_PATH, 'utf8'));
  const candidates = TEST_ROOTS
  .flatMap((root) => testFilesUnder(root))
  .map((path) => ({path, source: readFileSync(path, 'utf8')}))
  .filter(({source}) => QUOTED_IDENTITY.test(source) || IMPORTED_CLASS.test(source));


  it('still has two rejections to tell apart', () => {
    expect(messages.length, PREMISE_GONE).toBeGreaterThanOrEqual(2);
    expect(new Set(messages).size, PREMISE_GONE).toBe(messages.length);
  });


  it('cannot tell them apart by name and code', async() => {
    // Deliberately never started: this is the shape every consumer sees when after() was bypassed,
    // and the shape impulseSessionGate.test.ts accidentally asserted against.
    const {whenImpulseSessionReady} = await import('@lib/impulse/session');

    const bypass = await whenImpulseSessionReady().then(
      () => ({name: 'gate opened', code: 'gate opened', message: 'gate opened'}),
      (error: any) => ({name: error?.name, code: error?.code, message: error?.message})
    );

    expect(bypass, NAME_AND_CODE_DO_NOT_DISCRIMINATE).toMatchObject({name: ERROR_NAME, code: ERROR_CODE});
    expect(messages, NAME_AND_CODE_DO_NOT_DISCRIMINATE).toContain(bypass.message);
  });


  it('pins the message everywhere the error is asserted', () => {
    expect(candidates.length, NOTHING_SWEPT).toBeGreaterThan(0);

    const undistinguished = candidates
    .filter(({source}) => !messages.some((message) => source.includes(message)))
    .map(({path}) => path);

    expect(
      undistinguished,
      `${undistinguished.join(', ')} asserts on the session gate error by ${ERROR_NAME}/${ERROR_CODE} ` +
      'without pinning which rejection it expects. Under vitest the DEV bypass is always armed, ' +
      'so such an assertion is satisfied by a gate that was merely asked too early and stays ' +
      'green even if the restore-failure path stops rejecting at all -- the path that keeps an ' +
      'unauthenticated boot wave from signing the user out (#137). Assert the message too: ' +
      `${messages.map((message) => JSON.stringify(message)).join(' or ')}.`
    ).toEqual([]);
  });
});
