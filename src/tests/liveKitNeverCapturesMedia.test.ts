import {readdirSync, readFileSync} from 'fs';
import {join} from 'path';

import {describe, expect, it} from 'vitest';

/*
 * Every camera and microphone capture in this app goes through getStream (@lib/calls/helpers/getStream): it
 * honours the device picked in Settings and heals a stale selection. LiveKit has helpers that open the
 * devices themselves; using one of them would bypass both, so the call code must never call them. The code
 * hands LiveKit tracks it captured, and unpublishes without stopping them.
 */
const BANNED: Array<{pattern: RegExp, why: string}> = [
  {pattern: /setMicrophoneEnabled\s*\(/, why: 'LocalParticipant.setMicrophoneEnabled calls getUserMedia itself'},
  {pattern: /setCameraEnabled\s*\(/, why: 'LocalParticipant.setCameraEnabled calls getUserMedia itself'},
  {pattern: /setScreenShareEnabled\s*\(/, why: 'LocalParticipant.setScreenShareEnabled calls getDisplayMedia itself'},
  {pattern: /createLocalTracks\s*\(/, why: 'createLocalTracks calls getUserMedia itself'},
  {pattern: /createLocalAudioTrack\s*\(|createLocalVideoTrack\s*\(|createLocalScreenTracks\s*\(/, why: 'the createLocal*Track helpers call getUserMedia itself'},
  {pattern: /switchActiveDevice\s*\(/, why: 'switchActiveDevice reacquires the device through getUserMedia'},
  {pattern: /\bgetUserMedia\s*\(/, why: 'capture goes through getStream'},
  {pattern: /\bgetDisplayMedia\s*\(/, why: 'screen capture goes through getScreenStream'}
];

function sourcesOf(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.ts')).map((name) => join(directory, name));
}

describe('call media is captured through getStream only', () => {
  const files = [
    ...sourcesOf('src/lib/calls/livekit'),
    'src/lib/calls/groupCallConnectionInstance.ts'
  ];

  it('scans the LiveKit layer', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s calls no LiveKit device helper and no getUserMedia', (file) => {
    const source = readFileSync(file, 'utf8').split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
    for(const {pattern, why} of BANNED) {
      expect(pattern.test(source), `${file} matches ${pattern}: ${why}`).toBe(false);
    }
  });
});
