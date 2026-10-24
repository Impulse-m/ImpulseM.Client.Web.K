import {liveLane} from './liveGate';
import {Centrifuge} from '@impulsem/centrifuge/build/protobuf';

import {socketUrlOf} from '../../../e2e/live/carriers';
import {loginCodeFor, Persona} from './personas';


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
    const [{create, fromBinary, toBinary}, {callPool}, schemas] = await Promise.all([
      import('@bufbuild/protobuf'),
      import('@lib/impulse/fleet/fleet'),
      import('@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb')
    ]);
    const request: Uint8Array = toBinary(schemas.ConnectionIdentityRequestSchema, create(schemas.ConnectionIdentityRequestSchema));
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

  // The same auth sequence the client's login page drives (see ./authFlow.ts), issued
  // through this driver's own socket so the primary stack's identity stays untouched.
  const app = (await import('@config/app')).default;

  const sentCode = await invoke('auth.sendCode', {
    phone_number: persona.phone,
    api_id: app.id,
    api_hash: app.hash,
    settings: {_: 'codeSettings', pFlags: {}}
  });

  if(!sentCode?.phone_code_hash) {
    throw new Error(
      `minimal RPC session: auth.sendCode returned no phone_code_hash (got ${JSON.stringify(sentCode?._)}) — ` +
      `is the dev stack up, and is "${persona.phone}" still a number of canon's reserved test ` +
      'block? The code is derived from the number itself (personas.ts), not configured.'
    );
  }

  let auth = await invoke('auth.signIn', {
    phone_number: persona.phone,
    phone_code_hash: sentCode.phone_code_hash,
    phone_code: loginCodeFor(persona)
  });

  if(auth?._ === 'auth.authorizationSignUpRequired') {
    auth = await invoke('auth.signUp', {
      phone_number: persona.phone,
      phone_code_hash: sentCode.phone_code_hash,
      first_name: persona.firstName,
      last_name: persona.lastName
    });
  }

  if(auth?._ !== 'auth.authorization') {
    throw new Error(
      `minimal RPC session: auth flow did not end in auth.authorization (got ${JSON.stringify(auth?._)})`
    );
  }

  if(typeof auth.session_token !== 'string' || !auth.session_token) {
    throw new Error(
      'minimal RPC session: auth.authorization carried no session_token — every later call of this ' +
      'driver would travel unauthenticated'
    );
  }

  identity.userId = String(auth.user.id);
  identity.sessionToken = auth.session_token;

  return {
    persona,
    userId: identity.userId,
    invoke
  };
}
