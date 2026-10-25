import {describe, expect, it} from 'vitest';

import {
  ephemeralBandHighestSlot,
  ephemeralBandLowestSlot,
  ephemeralPersona,
  redrawAfterReuse,
  slotOf
} from './liveharness/personas';


/*
 * Ephemeral personas draw their number uniformly from the allocatable band of canon's reserved test
 * block, and never hand the same slot out twice in one process. The backend draws the same way
 * (tests/ImpulseM.Client/Personas/Personas.cs, NextReservedNumber and DrawEphemeralSlot), so two
 * harnesses started against one stack do not walk the block in step and collide.
 *
 * The band is the block minus the slots the backend holds back: persistent identities take the
 * bottom 128 slots and hand-typed numbers the top 1000. A draw outside the band would name an
 * account another suite owns.
 */
describe('ephemeral personas draw distinct numbers from the allocatable band', () => {
  const distinctDraws: number = 2_000;

  it('draws every persona from the band, all distinct, across a large batch', () => {
    const phones: Set<string> = new Set<string>();
    for(let index: number = 0; index < distinctDraws; ++index) {
      const persona = ephemeralPersona(`draw-${index}`);
      const slot: number = slotOf(persona.phone);

      expect(slot, `${persona.phone} is outside the band of allocatable slots`)
        .toBeGreaterThanOrEqual(ephemeralBandLowestSlot);
      expect(slot, `${persona.phone} is outside the band of allocatable slots`)
        .toBeLessThanOrEqual(ephemeralBandHighestSlot);
      phones.add(persona.phone);
    }

    expect(phones.size).toBe(distinctDraws);
  });

  it('hands the same label the same persona object', () => {
    expect(ephemeralPersona('stable')).toBe(ephemeralPersona('stable'));
  });

  it('redraws a reused persona in place, and every later lookup of its label sees the new number', () => {
    const handedOut: string[] = [];
    for(let index: number = 0; index < 50; ++index) {
      handedOut.push(ephemeralPersona(`redraw-${index}`).phone);
    }

    const reused = ephemeralPersona('reused');
    const reusedPhone: string = reused.phone;
    handedOut.push(reusedPhone);

    redrawAfterReuse(reused);

    expect(reused.phone).not.toBe(reusedPhone);
    expect(ephemeralPersona('reused')).toBe(reused);
    expect(ephemeralPersona('reused').phone).toBe(reused.phone);
    expect(handedOut).not.toContain(reused.phone);
    expect(slotOf(reused.phone)).toBeGreaterThanOrEqual(ephemeralBandLowestSlot);
    expect(slotOf(reused.phone)).toBeLessThanOrEqual(ephemeralBandHighestSlot);
  });
});
