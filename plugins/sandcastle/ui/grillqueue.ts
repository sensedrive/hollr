/**
 * Starting grills (`grill-start` on the chosen machine via the host relay) and the queue behind „Alle auto-grillen“.
 * The queue lives in this page only: it starts the next ticket whenever a machine has fewer than two running or
 * waiting grills, and stops when the page is closed (the dialog says so).
 */
import { hasHost, openSession, sc } from "./api";
import { derive } from "./derive";
import { ADVISOR_RE, isBusyGrill, isLiveGrill, nextGrills, type QueuedGrill, rememberAdvisor } from "./grill";
import { errorText, hooks, prefGet, prefSet, serverLabel, state, toast } from "./state";
import type { Grill, GrillMode } from "./types";

/** starts the page sent and whose grill the status may not list yet: they count as busy for a while */
const recent: { server: string; slug: string; n: number; at: number }[] = [];
const RECENT_MS = 30_000;
let queue: QueuedGrill[] = [];
/** `${slug}#${n}` of starts in flight from the details panel or the card menu */
const starting = new Set<string>();
/** the same for starts the queue sent, with their machine (they count against its limit) */
const inflight = new Map<string, QueuedGrill>();

const ticketKey = (slug: string, n: number) => `${slug}#${n}`;

export const isStarting = (n: number) => starting.has(ticketKey(state.slug, n)) || inflight.has(ticketKey(state.slug, n));

/** The queued entry of a ticket of the selected repo, with its place on that machine. */
export function queuedGrill(n: number): { entry: QueuedGrill; place: number } | null {
  const entry = queue.find((q) => q.slug === state.slug && q.n === n);
  if (!entry) return null;
  return { entry, place: queue.filter((q) => q.server === entry.server).indexOf(entry) + 1 };
}

export const grillQueue = (): readonly QueuedGrill[] => queue;

/** Puts the answer of `grill-start` into the machine's status so board and Läufe show it before the next poll. */
function putGrill(server: string, grill: Grill): void {
  const status = state.statuses.get(server);
  if (!status) return;
  status.grills = [...(status.grills ?? []).filter((g) => g.id !== grill.id), grill];
}

/** A live grill for the ticket on any machine. */
function hasLiveGrill(slug: string, n: number): boolean {
  for (const status of state.statuses.values())
    if ((status.grills ?? []).some((g) => g.slug === slug && g.n === n && isLiveGrill(g))) return true;
  return false;
}

/**
 * Starts one grill. Interactive grills open their session in Hollr: the questions come there.
 */
export async function startGrill(server: string, n: number, mode: GrillMode, advisor: string | null): Promise<boolean> {
  const slug = state.slug;
  const key = derive().issues.get(n)?.jira ?? null;
  const id = ticketKey(slug, n);
  if (starting.has(id)) return false;
  if (hasLiveGrill(slug, n)) {
    toast(`Für #${n} läuft schon ein Grill.`);
    return false;
  }
  if (advisor && !ADVISOR_RE.test(advisor)) {
    toast("Advisor: nur Buchstaben, Ziffern und . : / - _ (höchstens 60 Zeichen).");
    return false;
  }
  starting.add(id);
  hooks.render();
  try {
    const { grill, note } = await sc.grillStart(server, slug, { n, key, mode, advisor: mode === "auto" ? advisor : null });
    recent.push({ server, slug, n, at: Date.now() });
    putGrill(server, grill);
    remember(server, mode, advisor);
    toast(`${mode === "auto" ? "Auto-Grill" : "Grill"} für #${n} auf ${serverLabel(server)} gestartet`, "info");
    if (note) toast(`#${n}: ${note}`);
    if (mode === "interactive" && grill.pane && hasHost()) openSession(server, grill.pane);
    return true;
  } catch (err) {
    toast(`#${n}: ${errorText(err)}`);
    return false;
  } finally {
    starting.delete(id);
    hooks.render();
  }
}

/** The machine and the advisor of the last auto-grill become the defaults (panel, dialog, card menu). */
function remember(server: string, mode: GrillMode, advisor: string | null): void {
  prefSet("grillServer", server);
  if (mode !== "auto") return;
  prefSet("grillAdvisor", advisor ?? "");
  if (advisor) prefSet("grillAdvisors", rememberAdvisor(prefGet<string[]>("grillAdvisors") ?? [], advisor));
}

/** Queues auto-grills for the tickets (already queued or live ones are skipped) and starts what fits now. */
export function enqueueAutoGrills(server: string, numbers: number[], advisor: string | null): void {
  if (advisor && !ADVISOR_RE.test(advisor)) {
    toast("Advisor: nur Buchstaben, Ziffern und . : / - _ (höchstens 60 Zeichen).");
    return;
  }
  const slug = state.slug;
  const d = derive();
  for (const n of numbers) {
    if (queue.some((q) => q.slug === slug && q.n === n) || hasLiveGrill(slug, n)) continue;
    queue.push({ server, slug, n, key: d.issues.get(n)?.jira ?? null, advisor });
  }
  remember(server, "auto", advisor);
  pumpGrills();
}

export function dequeueGrill(n: number): void {
  queue = queue.filter((q) => !(q.slug === state.slug && q.n === n));
  hooks.render();
}

/** Drops every waiting entry of the selected repo. */
export function clearGrillQueue(): void {
  queue = queue.filter((q) => q.slug !== state.slug);
  hooks.render();
}

/** Busy grills per machine: running/waiting ones in its status, recent starts it does not list yet, starts in flight. */
function busyCounts(now: number): Map<string, number> {
  const busy = new Map<string, number>();
  const add = (server: string) => busy.set(server, (busy.get(server) ?? 0) + 1);
  for (const [server, status] of state.statuses) for (const g of status.grills ?? []) if (isBusyGrill(g)) add(server);
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (!r) continue;
    if (now - r.at > RECENT_MS) recent.splice(i, 1);
    else if (!(state.statuses.get(r.server)?.grills ?? []).some((g) => g.slug === r.slug && g.n === r.n)) add(r.server);
  }
  for (const q of inflight.values()) add(q.server);
  return busy;
}

/** Called after every status poll and enqueue: starts queued grills where a machine has room. */
export function pumpGrills(): void {
  // a ticket someone grilled meanwhile (another machine, by hand) leaves the queue
  queue = queue.filter((q) => !hasLiveGrill(q.slug, q.n));
  for (const q of nextGrills(queue, busyCounts(Date.now()))) {
    const id = ticketKey(q.slug, q.n);
    queue = queue.filter((x) => x !== q);
    inflight.set(id, q);
    sc.grillStart(q.server, q.slug, { n: q.n, key: q.key, mode: "auto", advisor: q.advisor })
      .then(({ grill, note }) => {
        recent.push({ server: q.server, slug: q.slug, n: q.n, at: Date.now() });
        putGrill(q.server, grill);
        if (note) toast(`#${q.n}: ${note}`);
      })
      .catch((err) => toast(`#${q.n}: ${errorText(err)}`))
      .finally(() => {
        inflight.delete(id);
        hooks.render();
        pumpGrills();
      });
  }
  hooks.render();
}
