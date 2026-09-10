import {randomInt} from 'crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';


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
 * How far ahead of this run the shared cursor is kept. Same value as the C# side, and the file is
 * the same file: the two harnesses march through the block together instead of each choosing a
 * start and overlapping with the other's accounts.
 */
const cursorUpdateEvery = 256;

/**
 * The length this deployment issues, and the length canon's own example uses. A caller holding an
 * auth.sentCode answer should read it off sentCodeTypeSms.length and call codeForDc directly.
 */
const defaultCodeLength = 5;

const byLabel = new Map<string, Persona>();
let allocated = 0;


export function ephemeralPersona(label: string): Persona {
  const existing = byLabel.get(label);
  if(existing) {
    return existing;
  }

  allocated += 1;
  if(allocated > ephemeralSlotCount) {
    throw new Error(
      `This run has asked for ${allocated} identities and canon's reserved test block holds ` +
      `${ephemeralSlotCount} allocatable numbers. Allocating past the end would reuse a number ` +
      'this run already holds, and two scenarios sharing one account is not a failure either of ' +
      'them can report.'
    );
  }

  if(allocated % cursorUpdateEvery === 0) {
    advanceCursorTo(firstSlot + allocated + cursorUpdateEvery);
  }

  const persona: Persona = {
    phone: reservedNumberAt(slotFor(firstSlot, allocated)),
    firstName: label,
    lastName: 'Ephemeral'
  };
  byLabel.set(label, persona);

  return persona;
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


function slotFor(cursor: number, allocationOrdinal: number): number {
  const offset = (((cursor + allocationOrdinal) % ephemeralSlotCount) + ephemeralSlotCount) % ephemeralSlotCount;

  return persistentSlotCount + offset;
}


/**
 * Where this run starts allocating: where the previous run stopped, in whichever harness it was.
 * Best-effort by design — an unreadable or unwritable cursor falls back to a random start rather
 * than failing the run, because a suite that cannot start because of its own bookkeeping file is
 * worse than one that occasionally revisits a slot.
 */
function readAndAdvanceCursor(): number {
  const fallback = randomInt(ephemeralSlotCount);
  try {
    const path = cursorPath();
    mkdirSync(dirname(path), {recursive: true});
    const stored = existsSync(path) ? Number.parseInt(readFileSync(path, 'utf8').trim(), 10) : NaN;
    const start = Number.isFinite(stored)
      ? ((stored % ephemeralSlotCount) + ephemeralSlotCount) % ephemeralSlotCount
      : fallback;

    // Advanced immediately rather than after the fact, so a run killed part way through still does
    // not hand its slots to the next one.
    advanceCursorTo(start + cursorUpdateEvery);

    return start;
  } catch{
    return fallback;
  }
}


function advanceCursorTo(slot: number): void {
  try {
    writeFileSync(
      cursorPath(),
      String((((slot % ephemeralSlotCount) + ephemeralSlotCount) % ephemeralSlotCount))
    );
  } catch{
    // See readAndAdvanceCursor: bookkeeping must not be able to fail a run.
  }
}


function cursorPath(): string {
  const override = process.env.IMPULSE_SESSION_CACHE;
  const directory = override && override.length > 0 ? override : join(tmpdir(), 'impulsem-personas');

  return join(directory, 'reserved-block-cursor.txt');
}


const firstSlot = readAndAdvanceCursor();
