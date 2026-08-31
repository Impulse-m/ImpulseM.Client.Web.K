import {createHash, randomUUID} from 'crypto';


/*
 * Ephemeral test identities for the B1 live lane — the TS mirror of
 * tests/ImpulseM.Client/Personas/Personas.cs (Personas.Ephemeral) in the backend repo, and of
 * its two rules:
 *
 *   1. Every run of a process gets its own accounts, and the run is part of the identity.
 *      A phone derived from the label alone would name the same account on every run against a
 *      long-lived stack, so a scenario would inherit everything every previous run did in it —
 *      and a scenario that asserts what its account contains would be asserting the history of
 *      the stack.
 *   2. Two labels in one run are two accounts; the same label twice in one run is one account —
 *      that is how a two-party scenario is written.
 *
 * Phone block +997xxxxxxxx is deliberately DISTINCT from every other convention in either repo:
 *   +998xxxxxxxx — the C# harness's own ephemeral block (Personas.Ephemeral);
 *   +999100xxx   — the C# fixed Alice/Bob baseline pair;
 *   +999000001-3 — the client repo's legacy jest conformance trio;
 *   +711xxxxxxxx — ConvergenceStablePhone.
 * A collision across harnesses would look like a scenario that inexplicably found somebody
 * else's messages.
 *
 * The dev stack answers every auth.sendCode with the scripted code
 * (deploy/docker-compose.dev.yaml: Auth__Registration__UseTestCode=true, TestCode=11111), so an
 * ephemeral persona registers through the REAL client auth path with no SMS in the loop.
 */
export type Persona = {
  phone: string,
  firstName: string,
  lastName: string
};

const runIdentity = randomUUID();


export function ephemeralPersona(label: string): Persona {
  const digest = createHash('sha256').update(`${runIdentity}:${label}`).digest();
  const n = digest.readUInt32BE(0) % 90000000 + 10000000;
  return {
    phone: `+997${n}`,
    firstName: label,
    lastName: 'Ephemeral'
  };
}

/** The deterministic code every auth.sendCode yields on the dev stack (Auth__Registration__TestCode). */
export const devStackTestCode = '11111';
