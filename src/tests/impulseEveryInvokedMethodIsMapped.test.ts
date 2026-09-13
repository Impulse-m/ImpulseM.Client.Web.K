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
  const unimplementedNamespaces: Record<string, string> = {
    ephemeral: 'ImpulseM#453 -- our own namespace, not canon. protos/generated/ephemeral.proto ' +
      'declares four rpcs and the backend implements none of them, so mapping it here would ' +
      'trade NETWORKER_DISABLED for UNIMPLEMENTED without making an ephemeral message work. ' +
      'Removed from this list by the slice that serves them.'
  };

  const generatedDescriptorRoot = 'src/lib/impulse/grpc/gen';

  /**
   * Sites that build a method name by interpolation, and the names each one can produce.
   *
   * A template like `channels.${what}` leaves no literal for the sweep to find, so the names would
   * simply not be checked. Registering the site is not enough either -- an entry that only says
   * "this file is opaque" buys silence, which is what the blind spot already was. So an entry
   * carries the names themselves, taken from the declaration that bounds them, and those names are
   * checked exactly like any literal. The reason field says where that declaration is, so the list
   * can be verified by reading rather than trusted.
   */
  const interpolatedMethodNames: Record<string, {reason: string, methods: string[]}> = {
    'src/lib/appManagers/appChatsManager.ts': {
      reason: 'toggleSomething() invokes `channels.${what}`, and `what` is a closed union declared ' +
        'in its own signature -- the eight names below are that union, verbatim. A ninth added to ' +
        'the union without being added here leaves this guard reading eight of nine.',
      methods: [
        'channels.toggleJoinToSend',
        'channels.toggleJoinRequest',
        'channels.toggleForum',
        'channels.togglePreHistoryHidden',
        'channels.toggleAntiSpam',
        'channels.toggleViewForumAsMessages',
        'channels.toggleParticipantsHidden',
        'channels.toggleAutotranslation'
      ]
    }
  };

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
      if((path.endsWith('.ts') || path.endsWith('.tsx')) &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.test.tsx')) {
        found.push(path);
      }
    }
    return found;
  }

  /**
   * Commented-out call sites are not calls. `stories.canApplyBoost` is the case that forced this:
   * it sits behind `//` upstream and in this fork, and counting it would have put a method nobody
   * invokes on the list, next to methods that are actually dying — which is how a guard's output
   * stops being read.
   */
  function withoutComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
  }

  it('leaves no invoked method to fall through to a transport nothing answers', () => {
    const files = [...sourceFiles('src/lib'), ...sourceFiles('src/components')];

    expect(
      files.length,
      'this guard means something only while it still reads the source tree; finding almost no ' +
      'files means the walk stopped matching and its green says nothing'
    ).toBeGreaterThan(200);

    // EVERY invoke form, not just the positional one. This guard used to read `invokeApi('ns.m'`
    // alone and was blind to the object form that invokeApiSingleProcess / invokeApiHashable /
    // invokeApiCacheable take -- which is how communities.getJoinedCommunities went unmapped and
    // took the whole group-manager tab down with NETWORKER_DISABLED while the guard's own list
    // named eight of its siblings (ImpulseM#452). A guard that reads one of five call shapes
    // reports on one fifth of the surface and says nothing about the rest.
    //
    // The call-site patterns below are still only part of the picture, and the part they miss is
    // not small. A method name is very often assembled before the call rather than written inside
    // it, and every such name was invisible:
    //
    //   const method = isPollVote ? 'messages.readPollVotes' :
    //     isReaction ? 'messages.readReactions' : 'messages.readMentions';
    //   return this.apiManager.invokeApi(method, {...});
    //
    // -- three methods, none of them at a call site (appMessagesManager.readMentions). Same shape
    // for upload.saveFilePart / upload.saveBigFilePart (apiFileManager), contacts.block /
    // contacts.unblock (appUsersManager.toggleBlock), channels.setStickers /
    // channels.setEmojiStickers and messages.sendMedia / messages.sendMultiMedia. Roughly sixteen
    // methods sat outside a guard whose whole purpose is to have no outside.
    //
    // So two more shapes are read, and both stay anchored to an actual invoke: the literals inside
    // the method ARGUMENT of a call (which catches every `cond ? 'ns.a' : 'ns.b'`), and, when the
    // argument is a bare identifier, the literals in that identifier's own `const` declaration
    // (which catches the assemble-then-invoke shape above).
    //
    // Deliberately NOT a sweep over every `'<ns>.<name>'` literal in the tree: TL constructor
    // discriminators share that exact shape -- `{_: 'updates.difference'}`,
    // `'messages.stickerSet'`, `'payments.paymentReceipt'` -- and a namespace filter cannot tell
    // them from method names, because they live in the same namespaces. Tried it; it reported
    // fifty-odd constructors as unmapped methods. A guard whose output has to be filtered by hand
    // is a guard nobody reads.
    const namespaces = new Set(
      readdirSync(generatedDescriptorRoot)
        .filter((entry) => entry.endsWith('_pb.ts'))
        .map((entry) => entry.slice(0, -'_pb.ts'.length))
    );

    expect(
      namespaces.size,
      'the namespace set is derived from the generated descriptors; finding almost none means the ' +
      'generator output moved and every name below would stop being recognised as a method'
    ).toBeGreaterThan(10);

    const patterns = [
      /invokeApi(?:Single|After)?\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g,
      /\bmethod:\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g
    ];
    const methodLiteral = /'([a-zA-Z]+\.[a-zA-Z][a-zA-Z0-9]*)'/g;
    const invoked = new Map<string, string>();

    function record(method: string, file: string): void {
      if(namespaces.has(method.split('.')[0]) && !invoked.has(method)) {
        invoked.set(method, file);
      }
    }

    for(const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      for(const pattern of patterns) {
        pattern.lastIndex = 0;
        for(const match of text.matchAll(pattern)) {
          record(match[1], file);
        }
      }

      // The method argument of every invoke, up to the comma that ends it. A ternary between two
      // literals lives entirely inside that span.
      for(const match of text.matchAll(/invokeApi(?:Single|After)?\(([^,)]*)/g)) {
        methodLiteral.lastIndex = 0;
        for(const literal of match[1].matchAll(methodLiteral)) {
          record(literal[1], file);
        }
      }

      // An invoke whose argument is a bare identifier: read that identifier's own declaration.
      // `const method = isPollVote ? 'messages.readPollVotes' : ...;` is the shape, and the names
      // it can produce are all written down in it.
      for(const match of text.matchAll(/invokeApi(?:Single|After)?\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g)) {
        const declaration = new RegExp(`\\bconst\\s+${match[1]}\\s*=([^;]*);`, 'g');
        for(const declared of text.matchAll(declaration)) {
          methodLiteral.lastIndex = 0;
          for(const literal of declared[1].matchAll(methodLiteral)) {
            record(literal[1], file);
          }
        }
      }
    }

    // What is still outside, measured rather than disclaimed. A name interpolated into a template
    // (`channels.${what}`) has no literal anywhere for the sweep above to find, so each such site
    // has to say where its own set of names is declared -- the same rule as unimplementedNamespaces,
    // for the same reason: a blind spot nobody has to describe is where the next omission hides.
    const interpolatedCallSites = new Map<string, string>();
    for(const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      for(const match of text.matchAll(/`([a-zA-Z]+)\.\$\{/g)) {
        if(namespaces.has(match[1])) {
          interpolatedCallSites.set(`${file}: ${match[1]}.\${...}`, file);
        }
      }
    }

    expect([...interpolatedCallSites.keys()].filter(
      (site) => !(site.split(': ')[0] in interpolatedMethodNames)
    ), [
      'These sites build a method name by interpolation, so no literal exists for the sweep above',
      'to find and nothing here can tell whether the names they produce are mapped.',
      '',
      'Add the file to interpolatedMethodNames WITH the declaration that bounds its names, so the',
      'set is checkable by reading rather than by guessing.',
      ''
    ].join('\n')).toEqual([]);

    // Registered interpolated names are not merely excused -- they are checked, exactly like a
    // literal would be.
    for(const [file, declared] of Object.entries(interpolatedMethodNames)) {
      for(const method of declared.methods) {
        if(!invoked.has(method)) {
          invoked.set(method, file);
        }
      }
    }

    expect(
      invoked.size,
      'finding almost no literal invokeApi call sites means the pattern stopped matching how this ' +
      'codebase calls the API, and every assertion below is then vacuous'
    ).toBeGreaterThan(100);

    // The widened shapes prove themselves rather than being trusted. Each name below is reachable
    // ONLY through the shape it is listed for, so if that shape stops matching, this fails here --
    // loudly, at the sweep -- instead of quietly shrinking the surface the assertion below covers.
    // Checking only that nothing is unmapped cannot tell a complete sweep from an empty one.
    const reachableOnlyThroughAWidenedShape: Record<string, string> = {
      'messages.readPollVotes': 'assembled into a const by appMessagesManager.readMentions, never ' +
        'written at a call site',
      'upload.saveBigFilePart': 'assembled into a const by apiFileManager, never written at a call site',
      'contacts.unblock': 'the far branch of a ternary inside the method argument ' +
        '(appUsersManager.toggleBlock)',
      'channels.toggleAutotranslation': 'interpolated as `channels.${what}` ' +
        '(appChatsManager.toggleSomething), registered in interpolatedMethodNames'
    };

    expect(
      Object.keys(reachableOnlyThroughAWidenedShape).filter((method) => !invoked.has(method)),
      'These methods are reachable only through a call shape this guard was blind to until it was ' +
      'widened. Not finding one means that shape stopped being read, and the guard is back to ' +
      'reporting on less surface than it appears to:\n' +
      Object.entries(reachableOnlyThroughAWidenedShape)
        .map(([method, shape]) => `  ${method} -- ${shape}`)
        .join('\n')
    ).toEqual([]);

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
