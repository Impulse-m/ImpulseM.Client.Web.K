import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';

import {describe, expect, it} from 'vitest';

import {getMappedMethodNames} from '../lib/impulse/grpc/serviceMap';

/**
 * Every method this client calls must have a gRPC mapping, because the alternative is not an error.
 *
 * The transport port added a gRPC path beside the MTProto one and removed nothing. That was
 * deliberate and it is not the problem. The problem is what happens on a miss: `grpcInvoke` has an
 * explicit error for an unmapped method, but the caller only reaches `grpcInvoke` when the gRPC
 * path is taken at all — otherwise the call continues into the MTProto networker that this
 * deployment has no server for. So a method absent from the map does not fail loudly at the
 * boundary. It is handed to a transport nothing answers, and the feature hangs or dies somewhere
 * far away from the omission.
 *
 * That is why this is a guard and not a runtime check. A runtime check fires when a user reaches
 * the feature; this fires when the omission is written, which is the only moment anyone still knows
 * why the method was added.
 *
 * The audit that prompted it counted 28 such methods reachable from real call sites — the whole
 * `aicompose` namespace among them. Each one is a menu item that does nothing.
 */
describe('every invoked API method has a gRPC mapping', () => {
  /**
   * Namespaces the backend does not implement and is not expected to. Each entry needs a reason,
   * not just a name: an allowlist whose entries carry no reason becomes the place omissions go to
   * be forgotten, which is the failure this guard exists to prevent.
   */
  const unimplementedNamespaces: Record<string, string> = {};

  function sourceFiles(root: string): string[] {
    const found: string[] = [];
    for(const entry of readdirSync(root)) {
      const path = join(root, entry);
      if(statSync(path).isDirectory()) {
        if(entry === 'gen' || entry === 'node_modules') {
          continue;
        }
        found.push(...sourceFiles(path));
        continue;
      }
      if(path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        found.push(path);
      }
    }
    return found;
  }

  it('leaves no invoked method to fall through to a transport nothing answers', () => {
    const files = [...sourceFiles('src/lib'), ...sourceFiles('src/components')];

    expect(files.length).toBeGreaterThan(
      200,
      'this guard means something only while it still reads the source tree; finding almost no ' +
      'files means the walk stopped matching and its green says nothing'
    );

    // Only literal call sites. A name built at runtime cannot be checked here, and pretending
    // otherwise would make the count look better than the coverage is.
    const invoked = new Map<string, string>();
    for(const file of files) {
      const text = readFileSync(file, 'utf8');
      for(const match of text.matchAll(/invokeApi\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) {
        if(!invoked.has(match[1])) {
          invoked.set(match[1], file);
        }
      }
    }

    expect(invoked.size).toBeGreaterThan(
      100,
      'finding almost no literal invokeApi call sites means the pattern stopped matching how this ' +
      'codebase calls the API, and every assertion below is then vacuous'
    );

    const mapped = new Set(getMappedMethodNames());
    const unmapped = [...invoked.entries()]
      .filter(([method]) => !mapped.has(method))
      .filter(([method]) => !(method.split('.')[0] in unimplementedNamespaces))
      .map(([method, file]) => `${method}  (${file})`)
      .sort();

    expect(unmapped, [
      'These methods are called with a literal name and have no gRPC mapping. On a miss the call',
      'does not fail at the boundary — it continues into the MTProto networker, which this',
      'deployment does not serve, so the feature hangs or fails somewhere unrelated to the',
      'omission and nobody connects the two.',
      '',
      'Add the mapping, or add the namespace to unimplementedNamespaces WITH the reason it is not',
      'implemented. A bare name in that list is how the next omission will hide.',
      ''
    ].join('\n')).toEqual([]);
  });
});
