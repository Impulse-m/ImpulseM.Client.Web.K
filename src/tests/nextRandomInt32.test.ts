import {describe, expect, it, vi} from 'vitest';

const randomMock = vi.hoisted(() => ({next: 0}));
vi.mock('@helpers/array/randomize', () => ({
  default: (array: Uint32Array) => {
    array[0] = randomMock.next;
    return array;
  }
}));

import {nextRandomInt32, nextRandomUint} from '@helpers/random';

describe('nextRandomInt32', () => {
  it.each([
    [0, 0],
    [1, 1],
    [0x7FFFFFFF, 0x7FFFFFFF],
    [0x80000000, -0x80000000],
    [0xFFFFFFFF, -1],
    [3577303721, -717663575]
  ])('turns the unsigned draw %d into the TL int %d the wire accepts', (draw, expected) => {
    randomMock.next = draw;

    expect(nextRandomUint(32)).toBe(draw);
    expect(nextRandomInt32()).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(-0x80000000);
    expect(expected).toBeLessThanOrEqual(0x7FFFFFFF);
  });
});
