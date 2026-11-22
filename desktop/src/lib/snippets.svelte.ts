// Prompt snippets ("Prompt-Bausteine"): chips above the composer, edited in Settings → general. They belong to the
// user, not to this computer: the machines sync (machines.svelte.ts) carries them to the other devices, the newest
// edit wins – hence the edit time next to the list.
import { DEFAULT_SNIPPETS, move, parseSnippets, SNIPPETS_KEY } from "./assist";

/** ms of the last edit here (or of the version taken from another device) */
const STAMP_KEY = "hollr.snippets.updatedAt";

function load(): string[] {
  try {
    return parseSnippets(localStorage.getItem(SNIPPETS_KEY));
  } catch {
    return parseSnippets(null);
  }
}

function loadStamp(): number {
  try {
    const n = Number(localStorage.getItem(STAMP_KEY));
    // never stamped (before the sync): 1, so a version already on a server wins over it
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

class Snippets {
  list = $state<string[]>(load());
  updatedAt = loadStamp();
  add(text: string) {
    const s = text.trim();
    if (!s || this.list.includes(s)) return;
    this.list = [...this.list, s];
    this.save();
  }
  remove(i: number) {
    this.list = this.list.filter((_, j) => j !== i);
    this.save();
  }
  move(i: number, by: number) {
    this.list = move(this.list, i, by);
    this.save();
  }
  reset() {
    this.list = [...DEFAULT_SNIPPETS];
    this.save();
  }
  /** a newer version from another device (machines sync): keeps its time, so it doesn't count as an edit here */
  take(list: string[], updatedAt: number) {
    this.list = [...list];
    this.save(updatedAt);
  }
  save(updatedAt = Date.now()) {
    this.updatedAt = updatedAt;
    try {
      localStorage.setItem(SNIPPETS_KEY, JSON.stringify(this.list));
      localStorage.setItem(STAMP_KEY, String(updatedAt));
    } catch {}
  }
}

export const snippets = new Snippets();
