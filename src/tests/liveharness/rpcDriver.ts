import {liveLane} from './liveGate';
import {Centrifuge} from '@impulsem/centrifuge/build/protobuf';

import {socketUrlOf} from '../../../e2e/live/carriers';
import {Persona} from './personas';
import {AuthMethod, signInWithReuseRetries} from './signInCore';


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


export async function openMinimalRpcSession(gatewayOrigin: string, persona: Persona): Promise<MinimalRpcSession> {
  const identity: {userId?: string, sessionToken?: string} = {};
  const socketUrl = socketUrlOf(liveLane.updateWsOrigin ?? gatewayOrigin);
  let identityMint: Promise<string> | undefined;
  let socket: Centrifuge | undefined;
  let socketToken: string | undefined;

  const mintIdentity = async(): Promise<string> => {
    const [{fromBinary}, {callPool}, {connectionIdentityRequest}, schemas] = await Promise.all([
      import('@bufbuild/protobuf'),
      import('@lib/impulse/fleet/fleet'),
      import('@lib/impulse/identity'),
      import('@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb')
    ]);
    const request: Uint8Array = connectionIdentityRequest('');
    const reply: Uint8Array = await callPool({accountNumber: 1, method: 'connectionIdentity', request});
    return fromBinary(schemas.ConnectionIdentityResponseSchema, reply).identityToken;
  };
  const socketFor = (): Centrifuge => {
    const token = identity.sessionToken;
    if(!socket || socketToken !== token) {
      socket?.disconnect();
      socket = new Centrifuge(socketUrl, {
        token: '',
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

  const sessionTokenOf = (auth: any): string => {
    if(typeof auth.session_token !== 'string' || !auth.session_token) {
      throw new Error(
        'minimal RPC session: auth.authorization carried no session_token — every later call of this ' +
        'driver would travel unauthenticated'
      );
    }

    return auth.session_token;
  };

  let lastSignIn: any;

  // A spent attempt leaves either a session (an authorization) or an identity holding a pending
  // password check (SESSION_PASSWORD_NEEDED); the next attempt starts on a fresh identity either way.
  const signOutAttempt = async(): Promise<void> => {
    if(lastSignIn !== undefined) {
      identity.sessionToken = sessionTokenOf(lastSignIn);
      try {
        await invoke('auth.logOut', {});
      } finally {
        identity.sessionToken = undefined;
      }
    }
    lastSignIn = undefined;
    identityMint = undefined;
    socket?.disconnect();
    socket = undefined;
  };

  const invokeAuth = async(method: AuthMethod, params: any): Promise<any> => {
    if(method === 'auth.signIn') {
      lastSignIn = undefined;
    }
    const result: any = await invoke(method, params);
    if(method === 'auth.signIn') {
      lastSignIn = result;
    }

    return result;
  };

  // The same auth sequence the client's login page drives (see ./signInCore.ts), issued
  // through this driver's own socket so the primary stack's identity stays untouched.
  const app = (await import('@config/app')).default;
  const signedIn: any = await signInWithReuseRetries(
    invokeAuth,
    persona,
    app,
    signOutAttempt
  );

  identity.userId = String(signedIn.user.id);
  identity.sessionToken = sessionTokenOf(signedIn);

  return {
    persona,
    userId: identity.userId,
    invoke
  };
}
