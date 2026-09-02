/**
 * Runs each button's predicate only while the menu that asked for it is still alive.
 *
 * Building a context menu is a long async chain — seven awaits before the button list is even
 * assembled, then one `verify()` per button. If the chat is torn down inside that window (switch
 * chats, close the tab, a forced teardown), `Chat.destroy()` nulls `bubbles` while
 * `ChatContextMenu` still holds the same `Chat`, and the next `verify()` that reads
 * `this.chat.bubbles.canForward(...)` throws.
 *
 * The predicate is gated rather than the dereference guarded, deliberately. A null check at each
 * call site would let the menu finish building against a dead chat and render a half-populated
 * list — a wrong menu is worse than no menu, and it hides the race instead of ending it. A menu
 * whose chat is gone has no buttons, which is what returning nothing says.
 *
 * `isAlive` is the class's existing middleware, cleaned by `ChatContextMenu.cleanup()`. That is
 * reachable from `Chat.destroy()`, which calls `contextMenu?.destroy()` BEFORE it nulls `bubbles`
 * — so the gate closes strictly earlier than the field it protects disappears.
 */
export default async function filterButtonsWhileAlive<T>(
  buttons: T[],
  isAlive: () => boolean,
  keep: (button: T) => boolean | Promise<boolean>
): Promise<T[]> {
  const kept: T[] = [];

  for(const button of buttons) {
    if(!isAlive()) {
      return [];
    }

    if(await keep(button)) {
      kept.push(button);
    }
  }

  // Checked again after the last predicate: teardown during the final await would otherwise return
  // a list assembled for a chat that no longer exists.
  return isAlive() ? kept : [];
}
