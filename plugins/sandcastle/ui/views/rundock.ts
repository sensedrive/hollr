/**
 * The Sandcastle dock below the Tickets board: one row per machine with a live run (or a waiting queue) – machine,
 * model, branch, progress, then the run's tickets as chips in run order. Folds to one summary bar. A row is a drop
 * target (`data-column="lane@<server>"`): a ticket card dropped on it queues its children there. Clicking a row
 * opens the run in the side panel (details, phases per ticket, reorder, stop). Rows are cached and rebuilt only
 * when what they show changes, so polls never reset scroll positions.
 */
import { setLaneOrder, takeOutOfLane } from "../actions";
import { hasHost, openExternal, openSession, sc } from "../api";
import type { Derived, Lane } from "../derive";
import { chipText, type DockChip, dependsOn, flowStage, laneChips, moveChip, runProgress, STAGES, stageLine } from "../dock";
import { fill, h, icon, reconcile } from "../dom";
import { isBusy, since } from "../model";
import { errorText, hooks, prefGet, prefSet, state, toast } from "../state";
import { LANE_PREFIX } from "../tickets";
import type { Flow, Phase, Run } from "../types";
import { newRunModal } from "./newrun";
import { claimPanel, closeSidebar } from "./sidebar";

interface RowEls {
  el: HTMLElement;
  sig: string;
}

let root: HTMLElement | null = null;
let titleEl: HTMLElement;
let summaryEl: HTMLElement;
let bodyEl: HTMLElement;
const rowEls = new Map<string, RowEls>();
/** chips queued from this page a moment ago (dashed „neu · Platz N“), key → until */
const fresh = new Map<string, number>();
/** the run shown in the side panel (machine id) */
let sideServer: string | null = null;
let sidePanel: HTMLElement | null = null;
let sideSig = "";
let lastDerived: Derived | null = null;

const isOpen = () => prefGet<boolean>("dockOpen") ?? true;

export function runDockEl(): HTMLElement {
  if (root) return root;
  // Lucide ChevronDown; turned up while the dock is folded
  const chev = icon('<path d="m6 9 6 6 6-6"/>', "dock-chev");
  titleEl = h("b", {}, "Sandcastle");
  summaryEl = h("span", { class: "dock-summary muted" });
  const toggle = h("button", { class: "dock-toggle", "aria-expanded": "true" }, chev, titleEl);
  toggle.addEventListener("click", () => {
    prefSet("dockOpen", !isOpen());
    hooks.render();
  });
  const add = h("button", { class: "btn", onclick: () => newRunModal(null) }, "+ Neuer Lauf");
  bodyEl = h("div", { class: "dock-body" });
  root = h("section", { class: "dock", "aria-label": "Sandcastle-Läufe" }, h("div", { class: "dock-head" }, toggle, summaryEl, h("span", { class: "grow" }), add), bodyEl);
  bodyEl.addEventListener("click", onClick);
  return root;
}

function onClick(e: Event): void {
  const t = e.target as Element;
  const move = t.closest<HTMLElement>("[data-move]");
  const row = t.closest<HTMLElement>("[data-dock-server]");
  if (!row) return;
  const server = row.dataset.dockServer ?? "";
  if (t.closest("[data-start]")) {
    e.stopPropagation();
    newRunModal(server);
    return;
  }
  if (move) {
    e.stopPropagation();
    moveTicket(server, move.dataset.key ?? "", Number(move.dataset.move) as -1 | 1);
    return;
  }
  openRunSide(server);
}

/** Issue number → its JIRA ticket key (child of the ticket's GitHub family). */
function ticketKeys(): Map<number, string> {
  const out = new Map<number, string>();
  for (const t of state.jira?.tickets ?? []) for (const c of t.family.children) out.set(c.n, t.key);
  return out;
}

/** Live runs of the lane (the dock shows the first; a machine runs at most one from the board). */
const liveRun = (lane: Lane): Run | undefined => lane.runs.find((r) => r.status !== "ended");

function chipsOf(d: Derived, lane: Lane, keys: Map<number, string>): DockChip[] {
  const run = liveRun(lane);
  const flow = run?.flow;
  return laneChips(
    lane.order,
    (n) => keys.get(n),
    (n): Phase | undefined => {
      const tr = d.runs.get(n);
      if (tr && tr.server === lane.server.id && tr.run === run) return tr.issue.phase;
      return d.issues.get(n)?.state === "closed" ? "merged" : undefined;
    },
    // with a flow the steps come from its roles and assignment results
    flow ? (n) => flowStage(flow, n) : undefined,
  );
}

/** „wartet auf deine Antwort“ with „Sitzung öffnen“ while herdr says the run's session is blocked. */
function waitingNote(server: string, run: Run, cls: string): HTMLElement | null {
  if (run.status !== "waiting") return null;
  const pane = run.pane;
  const open = (e: Event) => {
    e.stopPropagation();
    if (pane) openSession(server, pane);
  };
  return h("span", { class: cls }, h("b", {}, "wartet auf deine Antwort"), pane && hasHost() ? h("button", { class: "btn small primary", onclick: open }, "Sitzung öffnen") : null);
}

/** „Worktree ✓ · Sandcastle ● · Prüfungen · …“ with the current stage highlighted. */
function stageLineEl(flow: Flow): HTMLElement {
  return h(
    "div",
    { class: "flow-stages", "aria-label": "Etappen" },
    ...stageLine(flow).flatMap((s, i) => [i ? h("span", { class: "sep" }, "·") : null, h("span", { class: `fstage ${s.state}${s.current ? " current" : ""}`, title: s.reason ?? "" }, s.text)]),
  );
}

const summaryOf = (key: string) =>
  state.jira?.tickets.find((t) => t.key === key)?.summary ?? (key.startsWith("#") ? (lastDerived?.issues.get(Number(key.slice(1)))?.title ?? "") : "");

/** Where Sandcastle has a ticket: lane machine, its place there, whether a run is live and building it. */
export interface TicketPlace {
  server: string;
  label: string;
  pos: number;
  live: boolean;
  busy: boolean;
}

/** Ticket key → its place, for the cards' „in Lauf auf … · Platz N“. */
export function ticketPlaces(d: Derived): Map<string, TicketPlace> {
  const keys = ticketKeys();
  const out = new Map<string, TicketPlace>();
  for (const lane of d.lanes)
    chipsOf(d, lane, keys).forEach((c, i) => {
      if (!out.has(c.key) && c.phase !== "merged")
        out.set(c.key, { server: lane.server.id, label: lane.server.label, pos: i + 1, live: !!liveRun(lane), busy: isBusy(c.phase) });
    });
  return out;
}

/** Marks a ticket as just queued (dashed chip) and says where it stands; null when it isn't in that lane. */
export function placeOf(d: Derived, key: string, server: string): number | null {
  const lane = d.lanes.find((l) => l.server.id === server);
  if (!lane) return null;
  const i = chipsOf(d, lane, ticketKeys()).findIndex((c) => c.key === key);
  if (i < 0) return null;
  fresh.set(key, Date.now() + 20_000);
  return i + 1;
}

function dots(chips: DockChip[]): HTMLElement {
  return h("span", { class: "dock-dots" }, ...chips.map((c) => h("span", { class: `seg ${c.phase}` })));
}

function chipEl(c: DockChip, i: number, chips: DockChip[]): HTMLElement {
  const isFresh = (fresh.get(c.key) ?? 0) > Date.now();
  const waiting = c.phase === "queued";
  const up = waiting && !!moveChip(chips, c.key, -1);
  const down = waiting && !!moveChip(chips, c.key, 1);
  return h(
    "div",
    { class: `dock-chip ph-${c.phase}${isFresh ? " fresh" : ""}`, title: `${c.key} ${summaryOf(c.key)}` },
    h(
      "div",
      { class: "dock-chip-top" },
      h("span", { class: "pos" }, i + 1),
      h("b", {}, c.key),
      h("span", { class: "grow" }),
      h("span", { class: "dock-chip-st" }, isFresh ? `neu · Platz ${i + 1}` : chipText(c)),
      waiting
        ? h(
            "span",
            { class: "dock-arrows" },
            h("button", { class: "arrow", "data-move": "-1", "data-key": c.key, disabled: !up, "aria-label": `${c.key} nach vorne` }, "←"),
            h("button", { class: "arrow", "data-move": "1", "data-key": c.key, disabled: !down, "aria-label": `${c.key} nach hinten` }, "→"),
          )
        : null,
    ),
    h("div", { class: "dock-chip-title" }, summaryOf(c.key)),
  );
}

function rowEl(lane: Lane, chips: DockChip[]): HTMLElement {
  const run = liveRun(lane);
  const id = lane.server.id;
  const now = Date.now();
  const sig = JSON.stringify([lane.server, run?.id, run?.branch, run?.config, run?.status, run?.pane, chips, [...fresh].filter(([, t]) => t > now).map(([k]) => k), chips.map((c) => summaryOf(c.key)), sideServer === id]);
  let row = rowEls.get(id);
  if (row?.sig === sig) return row.el;
  const p = runProgress(chips);
  const agent = run ? run.config.agentLabel || run.config.agent || "" : "";
  const el = h(
    "div",
    { class: `dock-row${sideServer === id ? " selected" : ""}${run ? "" : " idle"}`, "data-column": `${LANE_PREFIX}${id}`, "data-dock-server": id, role: "button", tabindex: 0 },
    h(
      "div",
      { class: "dock-machine" },
      h("b", { class: "dock-name" }, lane.server.label),
      h("span", { class: "dock-branch mono muted" }, run ? run.branch : ""),
      h("span", { class: "dock-agent muted" }, run ? agent : "kein Lauf"),
      run ? waitingNote(id, run, "dock-wait") : null,
      h(
        "span",
        { class: "dock-of" },
        chips.length ? (run ? `${p.at} von ${p.total}` : `${p.total} wartend`) : "",
        chips.length ? dots(chips) : null,
      ),
      // a machine without a run but with tickets waiting: start right from its row
      !run && chips.length
        ? h("button", { class: "btn small primary dock-start", "data-start": true, title: "Lauf auf diesem Rechner starten" }, "▷ Lauf starten")
        : null,
    ),
    h("div", { class: "dock-chips", "data-list": true }, ...(chips.length ? chips.map((c, i) => chipEl(c, i, chips)) : [h("p", { class: "empty" }, "Leer – Ticket hierher ziehen")])),
  );
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === el) openRunSide(id);
  });
  row = { el, sig };
  rowEls.set(id, row);
  return el;
}

/** Called by the Tickets view on every render. */
export function renderDock(d: Derived): void {
  if (!root) return;
  lastDerived = d;
  const keys = ticketKeys();
  const open = isOpen();
  const lanes = d.lanes.map((lane) => ({ lane, chips: chipsOf(d, lane, keys), run: liveRun(lane) })).filter((x) => x.run || x.chips.length);
  const live = lanes.filter((x) => x.run);
  titleEl.textContent = `Sandcastle · ${live.length} ${live.length === 1 ? "Lauf" : "Läufe"}`;
  root.querySelector(".dock-toggle")?.setAttribute("aria-expanded", String(open));
  root.classList.toggle("closed", !open);
  const summary = live.map((x) => {
    const p = runProgress(x.chips);
    return `${x.lane.server.label} ${p.at} von ${p.total}`;
  });
  summaryEl.textContent = open ? "" : summary.join(" · ");
  bodyEl.hidden = !open;
  if (open)
    reconcile(
      bodyEl,
      lanes.length
        ? lanes.map((x) => rowEl(x.lane, x.chips))
        : [h("p", { class: "empty" }, state.servers.length ? "Kein Lauf – „+ Neuer Lauf“ startet einen." : "Rechner werden gesucht …")],
    );
  renderRunSide(d);
}

function moveTicket(server: string, key: string, dir: -1 | 1): void {
  const d = lastDerived;
  const lane = d?.lanes.find((l) => l.server.id === server);
  if (!d || !lane) return;
  const order = moveChip(chipsOf(d, lane, ticketKeys()), key, dir);
  if (order) setLaneOrder(server, order);
}

// ---- run details in the side panel

export function openRunSide(server: string): void {
  sidePanel = claimPanel(() => {
    sideServer = null;
    sidePanel = null;
    hooks.render();
  });
  sideServer = server;
  sideSig = "";
  if (lastDerived) renderRunSide(lastDerived);
  hooks.render();
}

function stopButton(server: string, run: Run): HTMLElement {
  if (run.source === "manual")
    return h("button", { class: "btn", disabled: true, title: "Von Hand gestartet – in seiner Sitzung stoppen" }, "Lauf stoppen");
  // two steps instead of confirm(): embedded webviews answer confirm() with "no" without showing it
  const btn = h("button", { class: "btn", title: "Bricht den Lauf in seiner Sitzung ab (Ctrl-C) und gibt den Rechner frei." }, "Lauf stoppen");
  btn.addEventListener("click", async () => {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Wirklich stoppen?";
      setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = "Lauf stoppen";
      }, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await sc.stop(server);
      toast("Lauf gestoppt", "info");
    } catch (err) {
      toast(errorText(err));
    }
    await hooks.reloadStatus();
  });
  return btn;
}

function openLog(server: string, run: Run, n: number | null): void {
  const issue = n === null ? null : run.issues.find((i) => i.n === n);
  const logs = issue ? issue.logs : run.logs;
  const log = logs.find((l) => l.active) ?? logs[0];
  state.selection = { server, run: run.id, n, path: log?.path ?? null };
  state.grillSel = null;
  closeSidebar();
  hooks.show("runs");
}

function phaseChips(stage: number): HTMLElement {
  return h(
    "div",
    { class: "stage-chips" },
    ...STAGES.map((s, i) => h("span", { class: `stage${i < stage ? " done" : i === stage ? " current" : ""}` }, i < stage ? `✓ ${s}` : s)),
  );
}

function ticketBlock(server: string, run: Run | undefined, c: DockChip, i: number, chips: DockChip[]): HTMLElement {
  const d = lastDerived;
  const deps = d ? dependsOn(chips, c, (n) => d.issues.get(n)?.blockedBy ?? []) : [];
  const waitingOn = deps.find((k) => chips.find((x) => x.key === k)?.phase !== "merged");
  const reason = run?.issues.find((x) => c.children.includes(x.n) && x.reason)?.reason;
  const status =
    c.phase === "queued"
      ? waitingOn
        ? `wartet auf ${waitingOn}`
        : "wartet"
      : c.phase === "merged"
        ? "gemergt"
        : c.phase === "failed"
          ? `fehlgeschlagen${reason ? `: ${reason}` : ""}`
          : chipText(c).replace(/^[🔒⏱✓✗] /u, "");
  const logIssue = run?.issues.find((x) => c.children.includes(x.n) && x.logs.length);
  const up = moveChip(chips, c.key, -1);
  const down = moveChip(chips, c.key, 1);
  return h(
    "div",
    { class: `run-ticket ph-${c.phase}${deps.length ? " dep" : ""}` },
    deps.length ? h("div", { class: "dep-note muted" }, `↳ baut auf ${deps.join(", ")}`) : null,
    h("div", { class: "run-ticket-top" }, h("span", { class: "pos" }, i + 1), " ", h("b", {}, c.key), " ", h("span", {}, summaryOf(c.key)), isBusy(c.phase) ? h("span", { class: "lock", title: "wird gerade gebaut" }, "🔒") : null),
    phaseChips(c.stage),
    h(
      "div",
      { class: "run-ticket-st" },
      h("span", { class: `st ph-${c.phase}` }, status),
      h("span", { class: "grow" }),
      run && logIssue ? h("button", { class: "link", onclick: () => openLog(server, run, logIssue.n) }, "Protokoll") : null,
    ),
    c.phase === "queued"
      ? h(
          "div",
          { class: "run-ticket-actions" },
          h("button", { class: "arrow", disabled: !up, "aria-label": "Eins hoch", onclick: () => up && setLaneOrder(server, up) }, "↑"),
          h("button", { class: "arrow", disabled: !down, "aria-label": "Eins runter", onclick: () => down && setLaneOrder(server, down) }, "↓"),
          h("span", { class: "grow" }),
          h("button", { class: "link", onclick: () => takeOutOfLane(server, c.children) }, "Aus dem Lauf nehmen"),
        )
      : null,
  );
}

function renderRunSide(d: Derived): void {
  if (!sideServer || !sidePanel) return;
  const server = sideServer;
  const lane = d.lanes.find((l) => l.server.id === server);
  const run = lane ? liveRun(lane) : undefined;
  const chips = lane ? chipsOf(d, lane, ticketKeys()) : [];
  const sig = JSON.stringify([server, run, chips, chips.map((c) => summaryOf(c.key)), Math.floor(Date.now() / 60_000)]);
  if (sig === sideSig) return;
  sideSig = sig;
  const label = lane?.server.label ?? server;
  const p = runProgress(chips);
  fill(
    sidePanel,
    h("div", { class: "side-head" }, h("button", { class: "btn ghost", onclick: closeSidebar }, "✕ Schließen")),
    h(
      "div",
      { class: "side-body run-side" },
      h("h2", { class: "side-title" }, run ? `Lauf auf ${label}` : `Kein Lauf auf ${label}`),
      run
        ? h(
            "dl",
            { class: "side-meta" },
            h("dt", {}, "Ziel-Branch"),
            h("dd", { class: "mono" }, run.branch || "–"),
            h("dt", {}, "Agent"),
            h("dd", {}, run.config.agentLabel || run.config.agent || "–"),
            h("dt", {}, "Gestartet"),
            h("dd", {}, run.startedAt ? `vor ${since(run.startedAt)}` : "–"),
            run.flow?.iteration ? h("dt", {}, "Runde") : null,
            run.flow?.iteration ? h("dd", {}, `${run.flow.iteration.n}${run.flow.iteration.max ? ` von ${run.flow.iteration.max}` : ""}${run.flow.pass && run.flow.pass.n > 1 ? ` · Durchgang ${run.flow.pass.n}` : ""}`) : null,
            h("dt", {}, "Fortschritt"),
            h("dd", { class: "run-progress" }, h("b", {}, `${p.at} von ${p.total}`), dots(chips)),
            h("dt", {}, "Pull Request"),
            h("dd", {}, run.pr && run.slug ? h("button", { class: "link", onclick: () => openExternal(`https://github.com/${run.slug}/pull/${run.pr}`) }, `#${run.pr}`) : "noch keiner"),
          )
        : h("p", { class: "muted" }, chips.length ? "Diese Tickets warten auf den nächsten Lauf." : "Keine Tickets eingereiht."),
      run?.flow ? stageLineEl(run.flow) : null,
      run ? waitingNote(server, run, "run-wait") : null,
      run
        ? h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => openLog(server, run, null) }, "Protokoll öffnen"), stopButton(server, run))
        : h("div", { class: "btn-row" }, h("button", { class: "btn primary", onclick: () => newRunModal(server) }, "Lauf starten")),
      h("h3", { class: "run-side-h" }, `${run ? "Tickets im Lauf" : "Warteschlange"} (${chips.length})`),
      ...chips.map((c, i) => ticketBlock(server, run, c, i, chips)),
    ),
  );
}
