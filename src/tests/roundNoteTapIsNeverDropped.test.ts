import {beforeAll, describe, expect, it, vi} from 'vitest';

// CONTRACT — this module does not exist yet; the implementer extracts it from the round branch
// of src/components/wrappers/video.ts and wires that branch to use it:
//
//   // src/components/wrappers/utils/roundPlaybackTap.ts
//   export type RoundPlaybackTap = {
//     arm: (toggle: (e: MouseEvent) => void) => void,
//     destroy: () => void
//   };
//   export default function attachRoundPlaybackTap(divRound: HTMLElement): RoundPlaybackTap;
//
// Two properties, both of them things the current code does not have:
//
//   1. the tap listener goes on `divRound` — the element that spans the whole circle — at the
//      moment the bubble is BUILT, so it exists before any media is wired and so no layering
//      change inside the circle can orphan it;
//   2. a tap that arrives before the playback media is wired is REMEMBERED and replayed the
//      instant `arm` supplies the toggle, instead of being dropped.
//
// wrappers/video.ts then calls attachRoundPlaybackTap(divRound) where divRound is built, and
// `tap.arm(...)` inside onLoad in place of today's `attachClickEvent(canvas, ...)`.
type RoundPlaybackTap = {
  arm: (toggle: (e: MouseEvent) => void) => void,
  destroy: () => void
};

type AttachRoundPlaybackTap = (divRound: HTMLElement) => RoundPlaybackTap;

// Resolved at run time rather than imported statically, and deliberately so: the module below is
// the contract this file states, it does not exist yet, and a static import would paint the
// whole project's type-check red instead of this one suite. The load failure IS the red.
const contractPath: string = '../components/wrappers/utils/roundPlaybackTap';

let attachRoundPlaybackTap: AttachRoundPlaybackTap;

beforeAll(async() => {
  const loaded = await import(contractPath).catch((error: unknown) => {
    throw new Error(
      'CONTRACT MISSING: src/components/wrappers/utils/roundPlaybackTap.ts is not there, so the ' +
      'round note still wires its tap inside the deferred onLoad and a user who taps the circle ' +
      `before the server ack gets nothing (${String(error)})`
    );
  });

  attachRoundPlaybackTap = loaded.default as AttachRoundPlaybackTap;
});


// The live shape this pins (e2e/live/roundNoteTap.live.spec.ts, run against the dev stack):
// the sender's round note finishes uploading, its spinner clears, its preview is moving inside
// the circle — and the bubble carries no tap handler at all, because wrappers/video.ts attaches
// it inside `onLoad`, which for an outgoing message is deferred to the server ack:
//
//   what the user sees: spinner over the circle=false, the circle's preview is moving=true
//   document.elementFromPoint at the tap point returns <canvas class="video-round-canvas">
//   nodes of the round bubble that carry a tap handler:
//     (NONE — the bubble has no click handler anywhere in it: nothing the user presses can
//      start playback)
//   mousedown isTrusted=true at (1036, 510) -> <canvas class="video-round-canvas">
//   click     isTrusted=true at (1036, 510) -> <canvas class="video-round-canvas">
//
// The press is delivered to exactly the right element and dies there. Thirty seconds later the
// handler exists — too late for the user, who tapped once, saw nothing happen and moved on.
//
// The same capture disposes of the layering theory: `video.media-video` inside a round bubble is
// pointer-events:none (.bubble.round .media-video, src/scss/partials/_chatBubble.scss:873), so it
// never takes the press off the canvas. Delegation onto divRound is still what this contract
// asks for — not to fix that, but so that the wiring cannot be orphaned by a future restyle of
// the layers the circle is made of.
function buildRoundBubble(): {divRound: HTMLElement, canvas: HTMLCanvasElement} {
  // Node-for-node the subtree wrappers/video.ts builds: ring appended, then canvas and the
  // duration badge prepended in front of it, then the muted preview video appended last.
  const divRound = document.createElement('div');
  divRound.classList.add('media-round', 'z-depth-1');
  divRound.dataset.mid = '2578';

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.classList.add('progress-ring');
  const ringCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ringCircle.classList.add('progress-ring__circle');
  ring.append(ringCircle);
  divRound.append(ring);

  const canvas = document.createElement('canvas');
  canvas.classList.add('video-round-canvas');
  const spanTime = document.createElement('span');
  spanTime.classList.add('video-time');
  divRound.prepend(canvas, spanTime);

  const video = document.createElement('video');
  video.classList.add('media-video');
  divRound.append(video);

  document.body.append(divRound);
  return {divRound, canvas};
}


/** One user tap: the browser delivers both, and exactly one of them must run the toggle. */
function tap(element: Element): void {
  element.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
  element.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
}


describe('attachRoundPlaybackTap', () => {
  it('replays a tap that landed before the playback media was wired', () => {
    const {divRound, canvas} = buildRoundBubble();
    const handle = attachRoundPlaybackTap(divRound);
    const toggle = vi.fn();

    tap(canvas);
    handle.arm(toggle);

    expect(
      toggle,
      'the user tapped the circle while the note was still being wired up and the tap was thrown away — the exact user-visible shape of issue #112: a round note that looks finished (no spinner, preview moving) does nothing when tapped, with no player and no error'
    ).toHaveBeenCalledTimes(1);
  });


  it('runs the toggle exactly once per tap, whichever layer of the circle the user hits', () => {
    const {divRound} = buildRoundBubble();
    const handle = attachRoundPlaybackTap(divRound);
    const toggle = vi.fn();
    handle.arm(toggle);

    // Invariant over the WHOLE subtree, not a chosen sample: the user aims at a circle, not at a
    // node, and whichever element the browser decides is topmost at that pixel is what receives
    // the press. Any node that can be hit and does not reach the toggle is a dead tap.
    const layers = [divRound, ...Array.from(divRound.querySelectorAll('*'))];
    for(const layer of layers) {
      toggle.mockClear();
      tap(layer);
      expect(
        toggle,
        `a tap landing on <${layer.tagName.toLowerCase()} class="${String(layer.getAttribute('class'))}"> inside the round note did not start playback exactly once — the user aims at the circle, and every layer it is made of is a place their finger can land`
      ).toHaveBeenCalledTimes(1);
    }
  });


  it('collapses repeated taps made while the note was still being wired into one playback', () => {
    const {divRound, canvas} = buildRoundBubble();
    const handle = attachRoundPlaybackTap(divRound);
    const toggle = vi.fn();

    tap(canvas);
    tap(canvas);
    tap(canvas);
    handle.arm(toggle);

    expect(
      toggle,
      'a user who taps a not-yet-wired round note more than once had those taps replayed one after another, and a play/pause toggle run an even number of times leaves the note silent — exactly what they were tapping to avoid'
    ).toHaveBeenCalledTimes(1);
  });


  it('keeps working after the note is rebound to its finalized message', () => {
    const {divRound, canvas} = buildRoundBubble();
    const handle = attachRoundPlaybackTap(divRound);
    const beforeAck = vi.fn();
    const afterAck = vi.fn();

    handle.arm(beforeAck);
    handle.arm(afterAck);
    tap(canvas);

    expect(
      afterAck,
      'after the server ack rebinds the round note to its finalized message, a tap must drive the playback of THAT message; the note is otherwise wired to a message the client has already thrown away'
    ).toHaveBeenCalledTimes(1);
    expect(
      beforeAck,
      'the pre-ack toggle stayed live after the rebind, so one tap drives two playbacks — the second of them against the dead temporary message'
    ).not.toHaveBeenCalled();
  });


  it('stops responding once the bubble is destroyed', () => {
    const {divRound, canvas} = buildRoundBubble();
    const handle = attachRoundPlaybackTap(divRound);
    const toggle = vi.fn();
    handle.arm(toggle);

    handle.destroy();
    tap(canvas);

    expect(
      toggle,
      'a destroyed round bubble still answers taps, so a recycled or re-rendered bubble drives playback of the message that used to be there'
    ).not.toHaveBeenCalled();
  });
});
