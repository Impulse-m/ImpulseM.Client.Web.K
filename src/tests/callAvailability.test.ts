import {describe, expect, it} from 'vitest';
import isCallAvailable from '@lib/calls/helpers/callAvailability';

describe('call buttons follow userFull', () => {
  it('offers voice and video exactly as the server flags them', () => {
    expect(isCallAvailable({pFlags: {phone_calls_available: true}} as any, 'voice')).toBe(true);
    expect(isCallAvailable({pFlags: {phone_calls_available: true}} as any, 'video')).toBe(false);
    expect(isCallAvailable({pFlags: {video_calls_available: true}} as any, 'video')).toBe(true);
    expect(isCallAvailable({pFlags: {video_calls_available: true}} as any, 'voice')).toBe(false);
    expect(isCallAvailable({pFlags: {phone_calls_available: true, video_calls_available: true}} as any, 'video')).toBe(true);
  });

  it('offers nothing for a user with no flags, a private-calls user without them, or no profile', () => {
    expect(isCallAvailable({pFlags: {}} as any, 'voice')).toBe(false);
    expect(isCallAvailable({pFlags: {phone_calls_private: true}} as any, 'voice')).toBe(false);
    expect(isCallAvailable(undefined, 'voice')).toBe(false);
  });
});
