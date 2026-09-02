import {describe, expect, it} from 'vitest';
import filterButtonsWhileAlive from '@components/chat/filterButtonsWhileAlive';

// The CEO's report was "the context menu often breaks" with no repro, and nothing in Loki, because
// the throw happens inside an un-awaited promise chain that no handler covers. What actually breaks
// is a verify() reading this.chat.bubbles after Chat.destroy() nulled it mid-build.
describe('context menu button filtering', () => {
  it('keeps the buttons whose predicate passes while the menu is alive', async() => {
    const seen: string[] = [];

    const kept = await filterButtonsWhileAlive(
      ['reply', 'quote', 'delete'],
      () => true,
      (button) => {
        seen.push(button);
        return button !== 'delete';
      }
    );

    expect(kept).toEqual(['reply', 'quote']);
    expect(seen).toEqual(['reply', 'quote', 'delete']);
  });

  // The point of the gate: a predicate that would dereference a torn-down chat is never reached.
  // Guarding the dereference instead would let it run and return a half-built menu.
  it('stops running predicates the moment the menu dies', async() => {
    const seen: string[] = [];
    let alive = true;

    const kept = await filterButtonsWhileAlive(
      ['reply', 'quote', 'delete'],
      () => alive,
      (button) => {
        seen.push(button);
        alive = false; // the chat is torn down while the first verify() is in flight
        return true;
      }
    );

    expect(seen, 'the second predicate would have touched a dead chat').toEqual(['reply']);
    expect(kept).toEqual([]);
  });

  it('returns nothing when the menu dies during the last predicate', async() => {
    let alive = true;

    const kept = await filterButtonsWhileAlive(
      ['reply'],
      () => alive,
      async() => {
        await Promise.resolve();
        alive = false;
        return true;
      }
    );

    expect(kept, 'a list assembled for a chat that no longer exists is not a menu').toEqual([]);
  });

  it('opens no menu at all when the chat was already gone', async() => {
    const seen: string[] = [];

    const kept = await filterButtonsWhileAlive(
      ['reply', 'quote'],
      () => false,
      (button) => {
        seen.push(button);
        return true;
      }
    );

    expect(seen).toEqual([]);
    expect(kept).toEqual([]);
  });

  // A predicate that throws for its own reasons must still surface. Swallowing here would turn one
  // silent failure into another, which is the whole complaint.
  it('lets a predicate error propagate instead of hiding it', async() => {
    await expect(
      filterButtonsWhileAlive(
        ['reply'],
        () => true,
        () => {
          throw new TypeError('Cannot read properties of undefined (reading canForward)');
        }
      )
    ).rejects.toThrow('canForward');
  });
});
