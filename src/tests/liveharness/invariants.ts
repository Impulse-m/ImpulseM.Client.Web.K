import {create, toBinary} from '@bufbuild/protobuf';
import {expect} from 'vitest';


/*
 * Standing invariants of the B1 live lane. Every live scenario asserts all three; they exist
 * as reusable helpers precisely so the NEXT scenario gets them for free:
 *
 *   1. Zero unhandled rejections over the whole scenario (UnhandledRejectionGuard) — a real
 *      client that leaks a rejection has already lost work the user cannot see.
 *   2. Every RPC the flow issues must serialize (WireInvariants.observe replays the adapter's
 *      own buildProtoInit -> create -> toBinary stages) — a serialize-stage throw is a scenario
 *      failure naming the method and the field.
 *   3. Any id that reaches a wire request is server-shaped: a decimal-integer string or a safe
 *      integer. A fractional temp id ("2578.0001") on the wire is the proven live failure shape
 *      (commit 6750d8076).
 */
export type WireRecord = {
  method: string,
  params: any
};

export type WireSerializeFailure = {
  method: string,
  message: string
};

export type WireIdViolation = {
  method: string,
  path: string,
  value: string
};

export type WireDeps = {
  getServiceAndMethod(method: string): {service: any, method: any} | undefined,
  buildProtoInit(tlValue: any, schema: any): any
};

const ID_KEY_PATTERN = /^(id|random_id|access_hash)$|_id$/;
const SERVER_SHAPED_STRING = /^-?\d+$/;


export function isServerShapedId(value: unknown): boolean {
  if(typeof value === 'number') {
    return Number.isSafeInteger(value);
  }

  if(typeof value === 'string') {
    return SERVER_SHAPED_STRING.test(value);
  }

  return typeof value === 'bigint';
}


export class UnhandledRejectionGuard {
  public failures: string[] = [];

  private readonly handler = (reason: unknown) => {
    const rendered = reason instanceof Error ?
      `${reason.message}\n${reason.stack ?? ''}` :
      JSON.stringify(reason) ?? String(reason);
    this.failures.push(rendered);
  };


  public install(): void {
    process.on('unhandledRejection', this.handler);
  }


  public uninstall(): void {
    process.off('unhandledRejection', this.handler);
  }


  public assertNone(context: string): void {
    expect(
      this.failures,
      `unhandled rejection(s) escaped during "${context}" — in the real client each of these is ` +
      'work silently lost mid-flight (a send that never finalizes, a storage write that never ' +
      'lands) with nothing on screen to tell the user; the scenario fails on the first one'
    ).toEqual([]);
  }
}


export class WireInvariants {
  public records: WireRecord[] = [];
  public serializeFailures: WireSerializeFailure[] = [];
  public idViolations: WireIdViolation[] = [];


  /**
   * Wraps ApiManager.prototype.invokeApi of the CURRENT module graph. Prototype-level, so the
   * boot storm createManagers fires is observed too, not only what the test itself invokes.
   * Every invokeApi* variant funnels through invokeApi (apiManagerMethods.ts), and
   * apiFileManager calls this.apiManager.invokeApi — one seam covers the whole stack.
   */
  public attachToPrototype(apiManagerPrototype: any, deps: WireDeps): void {
    const invariants = this;
    const original = apiManagerPrototype.invokeApi;

    apiManagerPrototype.invokeApi = function(method: string, params?: any, options?: any) {
      invariants.observe(method, params ?? {}, deps);
      return original.call(this, method, params, options);
    };
  }


  public observe(method: string, params: any, deps: WireDeps): void {
    this.records.push({method, params});
    this.collectIdViolations(method, params, 'params');

    const mapping = deps.getServiceAndMethod(method);
    if(!mapping) {
      return;
    }

    try {
      // The exact stages grpcInvoke runs before the request leaves (grpc/adapter.ts) —
      // replayed here so a serialize failure is a named scenario failure even when the
      // production catch path swallows or reshapes it.
      const init = deps.buildProtoInit(params, mapping.method.input);
      const message = create(mapping.method.input, init);
      toBinary(mapping.method.input, message);
    } catch(error) {
      this.serializeFailures.push({
        method,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }


  public assertClean(context: string): void {
    expect(
      this.serializeFailures,
      `RPC(s) issued during "${context}" failed to serialize — in the real client the request ` +
      'dies inside the encoder, never reaches the wire, and whatever awaited it (a send, a ' +
      'download, a history fill) rejects opaquely; the failure names the method and field so ' +
      'the leak is diagnosable from this line alone'
    ).toEqual([]);

    expect(
      this.idViolations,
      `non-server-shaped id(s) reached a wire request during "${context}" — a fractional or ` +
      'otherwise malformed id is a client-local temp id of a still-pending entity leaking into ' +
      'a server request: the proven shape of the round-note spinner loss (commit 6750d8076)'
    ).toEqual([]);
  }


  private collectIdViolations(method: string, value: any, path: string): void {
    if(value === null || value === undefined) {
      return;
    }

    if(value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return;
    }

    if(Array.isArray(value)) {
      for(let i = 0; i < value.length; ++i) {
        this.collectIdViolations(method, value[i], `${path}[${i}]`);
      }

      return;
    }

    if(typeof value !== 'object') {
      return;
    }

    for(const key of Object.keys(value)) {
      const child = value[key];
      const childPath = `${path}.${key}`;

      if(ID_KEY_PATTERN.test(key) && (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint')) {
        if(!isServerShapedId(child)) {
          this.idViolations.push({method, path: childPath, value: String(child)});
        }

        continue;
      }

      this.collectIdViolations(method, child, childPath);
    }
  }
}
