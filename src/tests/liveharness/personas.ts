import {randomInt} from 'crypto';


/*
 * Ephemeral test identities for the live lanes — the TS mirror of
 * tests/ImpulseM.Client/Personas/Personas.cs and ReservedTestPhoneNumber.cs in the backend repo.
 *
 * Numbers come from the block canon reserves for test datacentres:
 *
 *   "If you wish to emulate an application of a user associated with DC number X, it is sufficient
 *    to specify the phone number as 99966XYYYY, where YYYY are random numbers, when registering the
 *    user. A user like this would always get XXXXX as the login confirmation code (the DC number,
 *    repeated five times). Note that the value of X must be in the range of 1-3 because there are
 *    only 3 Test DCs."
 *   (.demo/telegram-docs-text/api/auth.md:1003-1005)
 *
 * That is the whole mechanism by which these lanes sign in without a message being sent, and it
 * replaced a configured constant — the literal 11111, which the server handed to ANY number because
 * a boolean said so, including the number belonging to whoever owns the deployment. A derived code
 * opens only numbers nobody can receive a message on, which is why canon publishes the rule.
 *
 * This file used to hold that constant and its own +997 block. The backend moved and this did not,
 * so every live-lane sign-up answered "Invalid code" and both client live lanes were dark — no
 * scenario failed, they all failed IDENTICALLY at the fixture, which reads as an environment
 * problem rather than as a regression. Keeping the mirror exact is the point of this file.
 *
 * The two rules the C# side documents hold here too:
 *
 *   1. Every run of a process gets its own accounts, and the run is part of the identity. A phone
 *      derived from the label alone would name the same account on every run against a long-lived
 *      stack, so a scenario would inherit everything every previous run did in it.
 *   2. Two labels in one run are two accounts; the same label twice in one run is one account —
 *      that is how a two-party scenario is written.
 */
export type Persona = {
  phone: string,
  firstName: string,
  lastName: string
};

/** The literal prefix from the canon quote, without the DC digit. */
const reservedPrefix = '99966';

/** Canon writes the digits after the DC digit as YYYY. */
const randomPartLength = 4;

/** "the value of X must be in the range of 1-3 because there are only 3 Test DCs". */
const lowestDcNumber = 1;
const highestDcNumber = 3;

/** Three DC digits by ten thousand random parts. */
const blockCapacity = (highestDcNumber - lowestDcNumber + 1) * 10_000;

/**
 * Slots the backend's allocator holds back, mirrored EXACTLY: persistent identities take the
 * bottom of the block and hand-typed numbers the top, and a lane that allocated over either would
 * put two parties in one account — the failure the whole scheme exists to prevent.
 */
const persistentSlotCount = 128;
const manualSlotCount = 1000;
const ephemeralSlotCount = blockCapacity - persistentSlotCount - manualSlotCount;

/**
 * The length this deployment issues, and the length canon's own example uses. A caller holding an
 * auth.sentCode answer should read it off sentCodeTypeSms.length and call codeForDc directly.
 */
const defaultCodeLength: number = 5;

/** The last name every ephemeral persona carries; a persona with it is a number this harness drew. */
export const ephemeralLastName: string = 'Ephemeral';

const byLabel: Map<string, Persona> = new Map<string, Persona>();

/** Every band slot this process has drawn. A slot is never handed out twice, reused or not. */
const drawnSlots: Set<number> = new Set<number>();


export function ephemeralPersona(label: string): Persona {
  const existing: Persona | undefined = byLabel.get(label);
  if(existing) {
    return existing;
  }

  const persona: Persona = {
    phone: reservedNumberAt(drawEphemeralSlot()),
    firstName: label,
    lastName: ephemeralLastName
  };
  byLabel.set(label, persona);

  return persona;
}


/**
 * Replaces the number of a persona whose number already holds an account. The persona object is
 * kept, so every holder and every later ephemeralPersona(label) sees the new number. The old slot
 * stays drawn and is not handed out again in this process.
 */
export function redrawAfterReuse(persona: Persona): void {
  persona.phone = reservedNumberAt(drawEphemeralSlot());
}


/**
 * The code canon owes this persona's number: "XXXXX as the login confirmation code (the DC number,
 * repeated five times)". Derived from the number itself, so there is nothing to keep in sync.
 */
export function loginCodeFor(persona: Persona): string {
  const dcNumber = parseReservedDcNumber(persona.phone);
  if(dcNumber === undefined) {
    throw new Error(
      `"${persona.phone}" is not a number of canon's reserved test block, so its login code is not ` +
      'derivable and would have to be delivered by SMS to a real phone. Allocate identities ' +
      'through ephemeralPersona.'
    );
  }

  return codeForDc(dcNumber, defaultCodeLength);
}


export function codeForDc(dcNumber: number, codeLength: number): string {
  if(dcNumber < lowestDcNumber || dcNumber > highestDcNumber) {
    throw new Error(`DC number ${dcNumber} is outside canon's test range ${lowestDcNumber}-${highestDcNumber}`);
  }

  return String(dcNumber).repeat(codeLength);
}


/**
 * True only for a number of the block, and the length is checked exactly rather than by prefix:
 * 999661234567 merely STARTS with the prefix and is somebody's real number in some plan.
 */
export function parseReservedDcNumber(phoneNumber: string): number | undefined {
  const digits = phoneNumber.replace(/\D/g, '');
  if(digits.length !== reservedPrefix.length + 1 + randomPartLength) {
    return undefined;
  }

  if(!digits.startsWith(reservedPrefix)) {
    return undefined;
  }

  const dcNumber = Number(digits[reservedPrefix.length]);
  if(dcNumber < lowestDcNumber || dcNumber > highestDcNumber) {
    return undefined;
  }

  return dcNumber;
}


function reservedNumberAt(slot: number): string {
  const wrapped = ((slot % blockCapacity) + blockCapacity) % blockCapacity;
  const dcNumber = lowestDcNumber + Math.floor(wrapped / 10_000);
  const randomPart = String(wrapped % 10_000).padStart(randomPartLength, '0');

  return `+${reservedPrefix}${dcNumber}${randomPart}`;
}


/**
 * Draws a band slot uniformly at random and redraws while the slot is already held by this process.
 * Mirrors DrawEphemeralSlot on the backend: the draw is random rather than sequential, so two
 * harnesses started against one stack do not walk the block in step.
 */
function drawEphemeralSlot(): number {
  if(drawnSlots.size >= ephemeralSlotCount) {
    throw new Error(
      `This run has drawn all ${ephemeralSlotCount} allocatable numbers of canon's reserved test ` +
      'block. Drawing again would reuse a number this run already holds, and two scenarios sharing ' +
      'one account is not a failure either of them can report.'
    );
  }

  let slot: number = persistentSlotCount + randomInt(ephemeralSlotCount);
  while(drawnSlots.has(slot)) {
    slot = persistentSlotCount + randomInt(ephemeralSlotCount);
  }
  drawnSlots.add(slot);

  return slot;
}
