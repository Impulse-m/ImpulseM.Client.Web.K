import {expect, it} from 'vitest';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack} from './managerStack';
import {signInHeadless} from './authFlow';
import {ephemeralPersona} from './personas';
import {RealtimeWireObserver} from './realtimeWire';

describeLive('identity-path sign-in on the live stack', () => {
  it('mints on the pool, logs in on the identity and presents the access JWT after reconnect', async() => {
    const wire: RealtimeWireObserver = new RealtimeWireObserver();
    const stack = await bootLiveManagerStack(liveLane.gatewayOrigin, {afterEnvInstalled: (): void => wire.install()});
    try {
      await signInHeadless(stack, ephemeralPersona('IdentityPath'));
      await stack.managers.apiManager.invokeApi('help.getConfig', {});
      const {getGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');
      const access: string | undefined = getGrpcSessionToken(stack.accountNumber);
      expect(access).toBeTruthy();
      const poolCall = wire.commands.find((entry) => entry.command.rpc?.method === 'connectionIdentity');
      expect(poolCall).toBeDefined();
      const updateOrigin: string = liveLane.updateWsOrigin || liveLane.gatewayOrigin.replace(/^http/, 'ws');
      const poolOrigin: string = liveLane.poolWsOrigin || updateOrigin;
      expect(new URL(poolCall.endpoint).origin).toBe(poolOrigin);
      expect(new URL(poolCall.endpoint).pathname).toBe(liveLane.poolWsOrigin ? '/connection/websocket' : '/pool/connection/websocket');
      const connects = wire.commands.filter((entry) => entry.command.connect);
      const identityConnect = connects.find((entry) => entry.command.connect.token && entry.command.connect.token !== access);
      expect(identityConnect).toBeDefined();
      const claims: {sub: string} = JSON.parse(Buffer.from(identityConnect.command.connect.token.split('.')[1], 'base64url').toString());
      expect(claims.sub.startsWith('i:')).toBe(true);
      const accessConnect = connects.find((entry) => entry.command.connect.token === access);
      expect(accessConnect).toBeDefined();
      expect(accessConnect.endpoint).toBe(identityConnect.endpoint);
      expect(new URL(accessConnect.endpoint).origin).toBe(updateOrigin);
      const poolConnect = connects.find((entry) => entry.endpoint === poolCall.endpoint);
      expect(poolConnect).toBeDefined();
      expect(poolConnect.command.connect.token || '').toBe('');
      const methods: string[] = wire.commands.flatMap((entry) => entry.command.rpc?.method ? [entry.command.rpc.method] : []);
      expect(methods).toContain('auth.sendCode');
      expect(methods).toContain('auth.signIn');
      const mintIndex: number = wire.commands.indexOf(poolCall);
      const loginIndex: number = wire.commands.findIndex((entry) => entry.command.rpc?.method === 'auth.sendCode');
      expect(mintIndex).toBeLessThan(wire.commands.indexOf(identityConnect));
      expect(wire.commands.indexOf(identityConnect)).toBeLessThan(loginIndex);
      expect(loginIndex).toBeLessThan(wire.commands.indexOf(accessConnect));
      const initIndex: number = wire.commands.findIndex((entry) => entry.command.rpc?.method === 'initConnection');
      expect(initIndex).toBeGreaterThan(-1);
      expect(wire.commands[initIndex].endpoint).toBe(identityConnect.endpoint);
      expect(initIndex).toBeGreaterThan(wire.commands.indexOf(identityConnect));
      expect(initIndex).toBeLessThan(loginIndex);
    } finally {
      await stack.dispose();
      wire.uninstall();
    }
  }, 120_000);
});
