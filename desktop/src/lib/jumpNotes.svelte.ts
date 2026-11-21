// Sprungmarken per Sitzung (server|pane): Merkzettel am linken Rand, Klick springt zurück (Chat oder Terminal).
import { t } from "./i18n";

export interface JumpNote {
  id: string;
  label: string;
  createdAt: number;
  /** Nachricht im Chat (`data-item`) */
  itemId?: string;
  /** Chat ohne Nachricht: Scrollposition */
  scrollY?: number;
  /** der markierte Text: findet die Stelle auch in der anderen Ansicht (Chat ↔ Terminal) */
  text?: string;
  /** Terminal: Zeile im ganzen Verlauf (von oben gezählt, herdr bzw. xterm) */
  termRow?: number;
}

const KEY = "hollr.jumpNotes";

function load(): Record<string, JumpNote[]> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // anything but an object ("null", a list) would break every session view reading its notes
    return all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, JumpNote[]>) : {};
  } catch {
    return {};
  }
}

function save(all: Record<string, JumpNote[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

const sessionKey = (server: string, pane: string) => `${server}|${pane}`;

class JumpNotes {
  bySession = $state(load());

  list(server: string, pane: string): JumpNote[] {
    return this.bySession[sessionKey(server, pane)] ?? [];
  }

  add(server: string, pane: string, note: Omit<JumpNote, "id" | "createdAt">): JumpNote {
    const key = sessionKey(server, pane);
    const entry: JumpNote = {
      ...note,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      label: note.label.trim() || t("Sprungmarke"),
    };
    const next = { ...this.bySession, [key]: [...(this.bySession[key] ?? []), entry] };
    this.bySession = next;
    save(next);
    return entry;
  }

  update(server: string, pane: string, id: string, label: string) {
    const key = sessionKey(server, pane);
    const list = this.bySession[key];
    if (!list) return;
    const next = {
      ...this.bySession,
      [key]: list.map((n) => (n.id === id ? { ...n, label: label.trim() || t("Sprungmarke") } : n)),
    };
    this.bySession = next;
    save(next);
  }

  remove(server: string, pane: string, id: string) {
    const key = sessionKey(server, pane);
    const list = this.bySession[key];
    if (!list) return;
    const next = { ...this.bySession, [key]: list.filter((n) => n.id !== id) };
    this.bySession = next;
    save(next);
  }
}

export const jumpNotes = new JumpNotes();
