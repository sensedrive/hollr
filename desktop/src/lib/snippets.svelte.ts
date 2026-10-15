// Prompt snippets ("Prompt-Bausteine"): chips above the composer, edited in Settings → general.
import { DEFAULT_SNIPPETS, move, parseSnippets, SNIPPETS_KEY } from "./assist";

function load(): string[] {
  try {
    return parseSnippets(localStorage.getItem(SNIPPETS_KEY));
  } catch {
    return parseSnippets(null);
  }
}

class Snippets {
  list = $state<string[]>(load());
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
  save() {
    try {
      localStorage.setItem(SNIPPETS_KEY, JSON.stringify(this.list));
    } catch {}
  }
}

export const snippets = new Snippets();
