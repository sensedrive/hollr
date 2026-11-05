// Sidechats ("Nachfragen"): a small chat about a selected piece of a session. Each one is a fork of the session
// (`api.fork`, like a chat with context; the first prompt asks it to only answer) – the agent knows the whole history, the panel only shows the
// quote and what was asked after it. Kept per computer, listed per session in the session's "Nachfragen" panel; their
// forks don't show as tabs or on the overview (their tab name starts with SIDECHAT_PREFIX).
export { FIRST_PREFIX, SIDECHAT_PREFIX, firstPrompt, isSideChatLabel, questionOf, sideChatLabel } from "./sidechat";

export interface SideChat {
  id: string;
  server: string;
  /** the session it is about */
  main: string;
  quote: string;
  created: number;
  /** its fork, once the first question went out */
  pane?: string;
  /** where the fork branched off (ms) – the log before it stays hidden */
  at?: number;
}

const KEY = "hollr.sidechats";
const MAX = 200;

function load(): SideChat[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as SideChat[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

class SideChats {
  all = $state<SideChat[]>(load());
  /** "open this one": set by the selection's "Nachfragen", taken by the session's view */
  request = $state<{ server: string; main: string; id: string } | null>(null);

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.all.slice(-MAX)));
    } catch {}
  }

  of(server: string, main: string) {
    return this.all.filter((c) => c.server === server && c.main === main).sort((a, b) => b.created - a.created);
  }

  /** a new one about `quote` – its fork starts with the first question */
  start(server: string, main: string, quote: string): string {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.all = [...this.all, { id, server, main, quote: quote.trim(), created: Date.now() }];
    this.save();
    this.request = { server, main, id };
    return id;
  }

  forked(id: string, pane: string, at: number) {
    this.all = this.all.map((c) => (c.id === id ? { ...c, pane, at } : c));
    this.save();
  }

  remove(id: string) {
    this.all = this.all.filter((c) => c.id !== id);
    this.save();
  }
}

export const sidechats = new SideChats();
