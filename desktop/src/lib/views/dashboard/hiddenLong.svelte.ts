// Long-running turns taken out of "Braucht dich" by hand: pane → start of the hidden turn, kept in the server's
// shared doc (the server forgets closed panes). The next turn of the same session shows up again (a different
// start time).
import { shared, showError } from "$lib/shared.svelte";
import type { PaneRef } from "$lib/store.svelte";

export const longHidden = (r: PaneRef, turnStartedAt: number) =>
  shared.of(r.server.id).hiddenLong[r.pane.pane] === turnStartedAt;

export function hideLong(r: PaneRef, turnStartedAt: number) {
  shared.update(r.server.id, () => [{ path: ["hiddenLong", r.pane.pane], value: turnStartedAt }]).catch(showError);
}
