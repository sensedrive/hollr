/**
 * „Maschine wechseln“, the pure parts: which machines can take a lane's queue, what the two queue files say after
 * the move, and which step of the setup on a machine without the project comes next.
 */
import type { CheckItem, QueueState, Server, SetupCheck, SetupFileInfo, Status, TicketFlags } from "./types";

/** ready: has the project · setup: online without it · busy: a run is live there · offline */
export type TargetKind = "ready" | "setup" | "busy" | "offline";

export interface SwitchTarget {
  server: Server;
  kind: TargetKind;
  /** why it can't take the queue (busy/offline) */
  reason: string | null;
}

/** Why a machine is busy: the board's run lock or any live run, null when it is free. */
export function runningOn(status: Status | undefined): string | null {
  const live = status?.runs.find((r) => r.status !== "ended");
  if (live) return `Lauf läuft (${live.project})`;
  if (status?.lock) return `Lauf läuft (${String(status.lock.project ?? "?")})`;
  return null;
}

/** Why the source can't hand its queue over, null when it can. */
export function switchBlocked(status: Status | undefined, queued: number): string | null {
  if (runningOn(status)) return "Hier läuft ein Lauf – umziehen geht erst nach dem Lauf.";
  if (!queued) return "Die Warteschlange ist leer – es gibt nichts umzuziehen.";
  return null;
}

const RANK: Record<TargetKind, number> = { ready: 0, setup: 1, busy: 2, offline: 3 };

/** The other machines, those that can take the queue first. A status not known yet counts as free. */
export function switchTargets(
  servers: readonly Server[],
  source: string,
  hasProject: (id: string) => boolean,
  statuses: ReadonlyMap<string, Status>,
): SwitchTarget[] {
  return servers
    .filter((s) => s.id !== source)
    .map((server): SwitchTarget => {
      if (!server.online) return { server, kind: "offline", reason: "offline" };
      const busy = runningOn(statuses.get(server.id));
      if (busy) return { server, kind: "busy", reason: busy };
      return { server, kind: hasProject(server.id) ? "ready" : "setup", reason: null };
    })
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.server.label.localeCompare(b.server.label, "de"));
}

export interface QueueMove {
  /** the target's new queue file: its own lane first, then the moved tickets in their order */
  target: { order: number[]; tickets: Record<string, TicketFlags> };
  /** the source's: without the moved tickets, their flags removed */
  source: { order: number[]; tickets: Record<string, null> };
}

/** `moving`: the source lane in order; `targetLane`: what the target's lane shows now. */
export function queueMove(moving: readonly number[], source: QueueState | undefined, targetLane: readonly number[]): QueueMove {
  const have = new Set(targetLane);
  const gone = new Set(moving);
  const tickets: Record<string, TicketFlags> = {};
  const cleared: Record<string, null> = {};
  for (const n of moving) {
    const flags = source?.tickets[String(n)];
    if (flags) {
      tickets[String(n)] = flags;
      cleared[String(n)] = null;
    }
  }
  return {
    target: { order: [...targetLane, ...moving.filter((n) => !have.has(n))], tickets },
    source: { order: (source?.order ?? []).filter((n) => !gone.has(n)), tickets: cleared },
  };
}

export type SetupStep = "clone" | "files" | "install" | "check";
export const SETUP_STEPS: readonly { id: SetupStep | "move"; label: string }[] = [
  { id: "clone", label: "Klonen" },
  { id: "files", label: "Dateien" },
  { id: "install", label: "Abhängigkeiten" },
  { id: "check", label: "Prüfung" },
  { id: "move", label: "Verschieben" },
];

/** Whether a step needs nothing more (`filesDone`: the user copied or skipped the files). */
export function stepDone(step: SetupStep, check: SetupCheck, filesDone: boolean): boolean {
  if (step === "clone") return check.cloned;
  if (step === "files") return filesDone || check.items.filter((i) => i.id.startsWith("file:")).every((i) => i.ok);
  if (step === "install") return check.cloned && (!check.pm || !!check.items.find((i) => i.id === "deps")?.ok);
  return false;
}

/** The first step that still needs something; the checklist once clone, files and install are through. */
export function nextStep(check: SetupCheck, filesDone: boolean, installSkipped: boolean): SetupStep {
  if (!stepDone("clone", check, filesDone)) return "clone";
  if (!stepDone("files", check, filesDone)) return "files";
  if (!installSkipped && !stepDone("install", check, filesDone)) return "install";
  return "check";
}

/**
 * The files the user can copy: what the source has; preselected when the target lacks it. A file the target has
 * is only copied when the user also ticks „überschreiben“.
 */
export function copyRows(source: readonly SetupFileInfo[], target: readonly SetupFileInfo[]) {
  return source
    .filter((f) => f.exists)
    .map((f) => ({ file: f, onTarget: target.some((t) => t.path === f.path && t.exists) }));
}

/** Byte size as the dialog shows it: 820 B, 1,5 KB. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} KB`;
}

/** „6 von 9 ok · 2 fehlen · 1 Hinweis“: hints (never blocking) count apart from what is missing. */
export function checkSummary(items: readonly CheckItem[]): string {
  const ok = items.filter((i) => i.ok).length;
  const missing = items.filter((i) => !i.ok && !i.hint).length;
  const hints = items.filter((i) => !i.ok && i.hint).length;
  return [
    `${ok} von ${items.length} ok`,
    missing ? `${missing} ${missing === 1 ? "fehlt" : "fehlen"}` : null,
    hints ? `${hints} ${hints === 1 ? "Hinweis" : "Hinweise"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
