import {describe, expect, it} from 'vitest';

import {codeForDc, ephemeralPersona, loginCodeFor, parseReservedDcNumber} from './liveharness/personas';


/*
 * The live lanes sign in without a message being sent ONLY because their numbers come from the
 * block canon reserves for test datacentres:
 *
 *   "If you wish to emulate an application of a user associated with DC number X, it is sufficient
 *    to specify the phone number as 99966XYYYY ... A user like this would always get XXXXX as the
 *    login confirmation code (the DC number, repeated five times). Note that the value of X must be
 *    in the range of 1-3 because there are only 3 Test DCs."
 *   (.demo/telegram-docs-text/api/auth.md:1003-1005)
 *
 * This guard exists because the harness already drifted off that rule once and nothing caught it.
 * The backend replaced a configured constant (the literal 11111, handed to ANY number because a
 * boolean said so) with the derived code above; this harness kept the constant and its own +997
 * block, and from then on every live-lane sign-up answered "Invalid code". Nothing reported a
 * regression, because every scenario failed IDENTICALLY at the shared fixture — which reads as
 * "the stack is down", not as "the harness is wrong". Both client live lanes were dark.
 *
 * The stakes are not only a dark lane. A number outside the block is an ordinary number in
 * somebody's plan, and it takes the REAL delivery path: the previous conventions were kept safe
 * only by the server declining to send. So this asserts the invariant, not a sample — an
 * allocation scheme that produced valid-looking numbers from the wrong range would pass any
 * assertion written against one known-good example.
 */
describe('live-lane personas stay inside canon\'s reserved test block', () => {
  const reservedShape = /^\+99966[1-3]\d{4}$/;

  const MUST_BE_RESERVED =
    'Every persona number must match canon\'s reserved test block +99966X{YYYY} with X in 1-3. A ' +
    'number outside it is an ordinary number in somebody\'s plan and takes the real SMS delivery ' +
    'path — the harness would be texting a stranger to sign itself in.';

  it('allocates every persona from the block, across a batch large enough to leave one slot', () => {
    // A batch rather than a single call: an allocator that walks off the end of the block, wraps
    // wrongly, or drifts into the persistent/manual reservations only shows it after several
    // allocations, and one known-good example would never see it.
    for(let index = 0; index < 200; ++index) {
      const persona = ephemeralPersona(`guard-${index}`);
      expect(persona.phone, `${MUST_BE_RESERVED} Offending persona: guard-${index}`)
        .toMatch(reservedShape);
    }
  });

  it('gives every persona a code derivable from its own number', () => {
    for(let index = 0; index < 20; ++index) {
      const persona = ephemeralPersona(`code-${index}`);
      const dcNumber = parseReservedDcNumber(persona.phone);

      expect(dcNumber, MUST_BE_RESERVED).toBeDefined();
      // "the DC number, repeated five times" — asserted as the rule rather than as a literal, so
      // this still holds if the deployment's code length ever changes.
      expect(
        loginCodeFor(persona),
        'the login code is the DC digit repeated for the length this deployment issues; anything ' +
          'else means the harness is typing a code the server will refuse, which is what took both ' +
          'live lanes dark'
      ).toBe(codeForDc(dcNumber!, 5));
    }
  });

  it('hands the same label the same account and different labels different accounts', () => {
    // The two rules the C# side documents, and the reason a scenario can name a role twice: a
    // two-party scenario is written by naming two labels, and a helper re-resolving one label must
    // not silently allocate a second, empty account.
    expect(ephemeralPersona('twin').phone).toBe(ephemeralPersona('twin').phone);
    expect(ephemeralPersona('left').phone).not.toBe(ephemeralPersona('right').phone);
  });

  it('refuses to derive a code for a number outside the block', () => {
    // 999661234567 merely STARTS with the prefix and is a real number in some plan. The length has
    // to be checked exactly, or a prefix match would quietly bless it.
    expect(parseReservedDcNumber('+999661234567')).toBeUndefined();
    expect(parseReservedDcNumber('+99966' + '4' + '0000')).toBeUndefined();
    expect(parseReservedDcNumber('+99712345678')).toBeUndefined();

    expect(
      () => loginCodeFor({phone: '+99712345678', firstName: 'x', lastName: 'y'}),
      'deriving a code for a number outside the block must throw rather than return something ' +
        'plausible: a silent answer here is how a harness ends up sending a real SMS'
    ).toThrow(/reserved test block/);
  });
});
