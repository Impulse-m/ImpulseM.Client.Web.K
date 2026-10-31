import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {resolveLiveLane} from './liveGate';


const poolEnvName: string = 'IMPULSE_LIVE_POOL_WS';
const testPoolWsOrigin: string = 'ws://localhost:5312';

function restoreEnv(name: string, value: string | undefined): void {
  if(value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe('live lane pool origin', () => {
  let savedPool: string | undefined;

  beforeEach(() => {
    savedPool = process.env[poolEnvName];
    delete process.env[poolEnvName];
  });

  afterEach(() => {
    restoreEnv(poolEnvName, savedPool);
  });

  it('defaults the live lane to the loopback test pool when IMPULSE_LIVE_POOL_WS is unset', () => {
    expect(resolveLiveLane().poolWsOrigin).toBe(testPoolWsOrigin);
  });

  it('answers the explicitly set IMPULSE_LIVE_POOL_WS instead of the test pool default', () => {
    process.env[poolEnvName] = 'ws://localhost:5399';

    expect(resolveLiveLane().poolWsOrigin).toBe('ws://localhost:5399');
  });

  it('keeps an explicitly empty IMPULSE_LIVE_POOL_WS as the way a lane disables the pool', () => {
    process.env[poolEnvName] = '';

    expect(resolveLiveLane().poolWsOrigin).toBe('');
  });
});
