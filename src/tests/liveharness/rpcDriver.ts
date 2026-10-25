import {liveLane} from './liveGate';
import {Centrifuge} from '@impulsem/centrifuge/build/protobuf';
import {NodeWebSocket} from '../api/nodeEnv';

import {socketUrlOf} from '../../../e2e/live/carriers';
import {Persona} from './personas';
import {findFreshNumber, signInWithReuseRetries} from './signInCore';


/*
 * A second, MINIMAL RPC session for two-party live scenarios.
 *
 * The manager stack is a per-process singleton graph (module-global session token, account
 * slots, fake-indexeddb) — two full stacks cannot coexist in one vitest process. When a
 * scenario needs a counterparty to ACT (send a message, flip online status) while the primary
 * stack observes, the counterparty is driven through this driver: the same update socket, the
 * same generated proto descriptors, the same TL<->proto conversion stages the production adapter
 * runs (buildProtoInit -> create -> transport-serialize, protoToTL back) — but its OWN socket and
 * its OWN identity, touching none of the module-global session state the primary stack lives on.
 *
 * Graph discipline: every invoke re-imports its codecs dynamically, so the driver always
 * speaks through the CURRENT module graph and survives the vi.resetModules a reboot performs.
 * The identity (user id + session token) is plain data and carries across graphs, exactly
 * like the persisted session of a real client.
 */
export type MinimalRpcSession = {
  persona: Persona,
  userId: string,
  invoke(method: string, params?: any): Promise<any>
};

type DriverSocket = {
  identity: {userId?: string, sessionToken?: string},
  invoke(method: string, params?: any): Promise<any>,
  abandonAttempt: () => Promise<void>,
  close: () => void
};


/**
 * Probes a reserved number over a throwaway socket, leaving the persona on a number that holds no
 * account. The socket is closed whether the probe returns or throws.
 */
export async function claimFreshNumber(gatewayOrigin: string, persona: Persona): Promise<void> {
  const socket: DriverSocket = openDriverSocket(gatewayOrigin);
  try {
    const app = (await import('@config/app')).default;
    await findFreshNumber(socket.invoke, persona, app, socket.abandonAttempt);
  } finally {
    socket.close();
  }
}

export async function openMinimalRpcSession(gatewayOrigin: string, persona: Persona): Promise<MinimalRpcSession> {
  const socket: DriverSocket = openDriverSocket(gatewayOrigin);
  try {
    // The same auth sequence the client's login page drives (see ./signInCore.ts), issued
    // through this driver's own socket so the primary stack's identity stays untouched.
    const app = (await import('@config/app')).default;
    const signedIn: any = await signInWithReuseRetries(socket.invoke, persona, app, socket.abandonAttempt);

    socket.identity.userId = String(signedIn.user.id);
    socket.identity.sessionToken = sessionTokenOf(signedIn);

    return {
      persona,
      userId: socket.identity.userId,
      invoke: socket.invoke
    };
  } catch(err: unknown) {
    socket.close();

    throw err;
  }
}

export type AnonymousRpcSession = {
  invoke(method: string, params?: any): Promise<any>,
  close(): void
};

/**
 * A signed-out driver session: it holds only the anonymous identity the update socket mints, so it
 * can make the login-only calls (auth.exportLoginToken) and nothing that needs an account.
 */
export function openAnonymousRpcSession(gatewayOrigin: string): AnonymousRpcSession {
  const socket: DriverSocket = openDriverSocket(gatewayOrigin);

  return {
    invoke: socket.invoke,
    close: socket.close
  };
}

function sessionTokenOf(auth: any): string {
  if(typeof auth.session_token !== 'string' || !auth.session_token) {
    throw new Error(
      'minimal RPC session: auth.authorization carried no session_token — every later call of this ' +
      'driver would travel unauthenticated'
    );
  }

  return auth.session_token;
}

function openDriverSocket(gatewayOrigin: string): DriverSocket {
  const identity: {userId?: string, sessionToken?: string} = {};
  const socketUrl = socketUrlOf(liveLane.updateWsOrigin ?? gatewayOrigin);
  let identityMint: Promise<string> | undefined;
  let socket: Centrifuge | undefined;
  let socketToken: string | undefined;

  // The identity is minted over a token-less socket of its own, so the app's pool fleet (slot 1's) never sees this driver.
  const mintIdentity = async(): Promise<string> => {
    const [{fromBinary}, {poolRpcEndpoint}, {connectionIdentityRequest}, schemas] = await Promise.all([
      import('@bufbuild/protobuf'),
      import('@lib/impulse/fleet/fleetRoute'),
      import('@lib/impulse/identity'),
      import('@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb')
    ]);
    const request: Uint8Array = connectionIdentityRequest('');
    const poolSocket: Centrifuge = new Centrifuge(poolRpcEndpoint(), {token: '', websocket: NodeWebSocket});
    poolSocket.connect();
    try {
      const reply = await poolSocket.rpc('connectionIdentity', request);
      if(reply.data === undefined) {
        throw new Error('minimal RPC session: connectionIdentity answered without data');
      }

      return fromBinary(schemas.ConnectionIdentityResponseSchema, reply.data).identityToken;
    } finally {
      poolSocket.disconnect();
    }
  };
  const socketFor = (): Centrifuge => {
    const token = identity.sessionToken;
    if(!socket || socketToken !== token) {
      socket?.disconnect();
      socket = new Centrifuge(socketUrl, {
        token: '',
        websocket: NodeWebSocket,
        getToken: async(): Promise<string> => token ?? await (identityMint ??= mintIdentity())
      });
      socketToken = token;
      socket.connect();
    }

    return socket;
  };

  const invoke = async(method: string, params: any = {}): Promise<any> => {
    const [{create, fromBinary, toBinary}, serviceMap, adapter, protoToTLModule] = await Promise.all([
      import('@bufbuild/protobuf'),
      import('@lib/impulse/grpc/serviceMap'),
      import('@lib/impulse/grpc/adapter'),
      import('@lib/impulse/grpc/protoToTL')
    ]);

    const mapping = serviceMap.getServiceAndMethod(method);
    if(!mapping) {
      throw new Error(`minimal RPC session: no mapping for ${method} — the update socket cannot serve it`);
    }

    const request = create(mapping.method.input, adapter.buildProtoInit(params, mapping.method.input));
    const reply = await socketFor().rpc(method, toBinary(mapping.method.input, request));
    if(reply.data === undefined) {
      throw new Error(`minimal RPC session: ${method} answered without data`);
    }

    return protoToTLModule.protoToTL(fromBinary(mapping.method.output, reply.data), mapping.method.output);
  };

  // A spent attempt leaves a session (an authorization) or an identity holding a pending password
  // check (SESSION_PASSWORD_NEEDED). Both are dropped here only, since auth.logOut would close the
  // socket under the call, and the next attempt starts on a fresh identity.
  const abandonAttempt = async(): Promise<void> => {
    identityMint = undefined;
    socket?.disconnect();
    socket = undefined;
  };

  const close = (): void => {
    socket?.disconnect();
    socket = undefined;
  };

  return {identity, invoke, abandonAttempt, close};
}
