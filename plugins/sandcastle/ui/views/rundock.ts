/**
 * The Sandcastle dock below the Tickets board: one row per machine with a live run (or a waiting queue) – machine,
 * model, branch, progress in children and the loop's round, then the run's tickets as chips in run order (x/y
 * children merged, most active status). Folds to one summary bar. A row is a drop target
 * (`data-column="lane@<server>"`): a ticket card dropped on it queues its children there. Clicking a row opens the
 * run in the side panel (round, stories with their child issues, reorder, stop; magicfink sandcastle-board v24).
 * Rows are cached and rebuilt only when what they show changes, so polls never reset scroll positions.
 */
import { setLaneOrder, takeOutOfLane } from "../actions";
import { hasHost, openExternal, openSession, sc } from "../api";
import type { Derived, Lane } from "../derive";
import {
  type RoleGroup,
  ROLE_LABEL,
  type ChildInfo,
  childLabel,
  childProgress,
  childSegment,
  childStatus,
  type DockChip,
  dependsOn,
  isWorking,
  laneChips,
  moveChip,
  ROUND_STEPS,
  type RoundStep,
  roundLine,
  type StoryActivity,
  storySummary,
} from "../dock";
import { fill, h, icon, reconcile } from "../dom";
import { ICON } from "../icons";
import { isBusy, since } from "../model";
import { errorText, hooks, prefGet, prefSet, state, toast } from "../state";
import { LANE_PREFIX } from "../tickets";
import { blindRun, timeline } from "../timeline";
import type { Phase, Run } from "../types";
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

function phaseIn(d: Derived, lane: Lane, run: Run | undefined, n: number): Phase | undefined {
  const tr = d.runs.get(n);
  if (tr && tr.server === lane.server.id && tr.run === run) return tr.issue.phase;
  return d.issues.get(n)?.state === "closed" ? "merged" : undefined;
}

function chipsOf(d: Derived, lane: Lane, keys: Map<number, string>): DockChip[] {
  const run = liveRun(lane);
  return laneChips(
    lane.order,
    (n) => keys.get(n),
    (n) => phaseIn(d, lane, run, n),
  );
}

/** What a lane's row and panel show: the run, its chips, each chip's children and the round. */
interface LaneView {
  run: Run | undefined;
  /** nothing reports where this run stands: children are „ohne Angabe“, never a guess */
  blind: boolean;
  chips: DockChip[];
  /** chip key → its children's states, in lane order */
  kids: Map<string, ChildInfo[]>;
  all: ChildInfo[];
  step: RoundStep | null;
  round: string;
  /** the round strip applies (a flow reports the loop running) */
  steps: boolean;
}

function laneView(d: Derived, lane: Lane, keys: Map<number, string>): LaneView {
  const run = liveRun(lane);
  const blind = !!run && blindRun(timeline(run));
  const chips = chipsOf(d, lane, keys);
  const phase = (n: number) => phaseIn(d, lane, run, n);
  const kids = new Map(
    chips.map((c) => [
      c.key,
      c.children.map((n) =>
        childStatus(n, {
          phase: phase(n),
          flow: run?.flow,
          blind,
          // an open blocker the run hasn't merged yet
          blocker: d.issues.get(n)?.blockedBy.find((b) => b !== n && d.open.has(b) && phase(b) !== "merged") ?? null,
          reason: run?.issues.find((i) => i.n === n)?.reason ?? null,
        }),
      ),
    ]),
  );
  const all = [...kids.values()].flat();
  const r = roundLine(run?.flow, blind, all);
  return { run, blind, chips, kids, all, step: r.step, round: r.text, steps: r.steps };
}

/** One segment per child: grey waits, blue implementer, purple review, outlined green waits for merge, green merged. */
function kidBar(kids: readonly ChildInfo[], label: string): HTMLElement {
  return h("span", { class: "kid-bar", role: "img", "aria-label": label }, ...kids.map((k) => h("span", { class: `seg ${childSegment(k)}` })));
}

const ACTIVITY_ICON: Record<StoryActivity, string> = {
  working: ICON.hammer,
  merging: ICON.gitMerge,
  ready: ICON.gitMerge,
  waiting: ICON.clock,
  failed: ICON.alert,
  done: ICON.check,
  unknown: ICON.circleHelp,
};

/** „🔨 #3605 · 🔍 #3604“; a single role names itself: „🔨 Implementer #3605“ (hammer implementer, magnifier review). */
function rolesEl(roles: readonly RoleGroup[]): HTMLElement {
  return h(
    "span",
    { class: "roles" },
    ...roles.map((g, i) =>
      h(
        "span",
        { class: "role", "data-role": g.role },
        i ? h("span", { class: "role-sep", "aria-hidden": "true" }, "·") : null,
        icon(g.role === "implementer" ? ICON.hammer : ICON.search, "role-ico"),
        h("span", { class: roles.length === 1 ? "" : "sr" }, `${ROLE_LABEL[g.role]} `),
        g.numbers.map((n) => `#${n}`).join(", "),
      ),
    ),
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

/** The tickets (chips) of one machine's lane in lane order, as the dock shows them; [] without a lane. */
export function laneChipsOf(d: Derived, server: string): DockChip[] {
  const lane = d.lanes.find((l) => l.server.id === server);
  return lane ? chipsOf(d, lane, ticketKeys()) : [];
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

function chipEl(c: DockChip, i: number, v: LaneView): HTMLElement {
  const isFresh = (fresh.get(c.key) ?? 0) > Date.now();
  const waiting = c.phase === "queued";
  const up = waiting && !!moveChip(v.chips, c.key, -1);
  const down = waiting && !!moveChip(v.chips, c.key, 1);
  const kids = v.kids.get(c.key) ?? [];
  const s = storySummary(kids, v.step);
  return h(
    "div",
    { class: `dock-chip${waiting ? "" : " fixed"}${isFresh ? " fresh" : ""}`, "data-activity": s.activity, title: `${c.key} ${summaryOf(c.key)}` },
    h(
      "div",
      { class: "dock-chip-top" },
      h("span", { class: "pos" }, i + 1),
      h("b", {}, c.key, h("span", { class: "dock-chip-n" }, ` · ${s.count}`)),
      // status and arrows stay together; on a narrow chip they wrap to a second line as one
      h(
        "span",
        { class: "dock-chip-end" },
        h(
          "span",
          { class: "dock-chip-st", "data-activity": isFresh ? "fresh" : s.activity },
          isFresh || s.roles.length ? null : icon(ACTIVITY_ICON[s.activity], "dock-chip-ico"),
          isFresh ? `neu · Platz ${i + 1}` : s.roles.length ? rolesEl(s.roles) : s.label,
        ),
        waiting
          ? h(
              "span",
              { class: "dock-arrows" },
              h("button", { class: "arrow", "data-move": "-1", "data-key": c.key, disabled: !up, "aria-label": `${c.key} nach vorne` }, "←"),
              h("button", { class: "arrow", "data-move": "1", "data-key": c.key, disabled: !down, "aria-label": `${c.key} nach hinten` }, "→"),
            )
          : null,
      ),
    ),
    h("div", { class: "dock-chip-title" }, summaryOf(c.key)),
    kids.length ? kidBar(kids, `${c.key}: ${s.count}${v.blind ? "" : " gemergt"}, ${s.label}`) : null,
  );
}

function rowEl(lane: Lane, v: LaneView): HTMLElement {
  const { run, chips } = v;
  const id = lane.server.id;
  const now = Date.now();
  const sig = JSON.stringify([lane.server, run?.id, run?.branch, run?.config, run?.status, run?.pane, v.blind, v.round, v.step, chips, [...v.kids], [...fresh].filter(([, t]) => t > now).map(([k]) => k), chips.map((c) => summaryOf(c.key)), sideServer === id]);
  let row = rowEls.get(id);
  if (row?.sig === sig) return row.el;
  const p = childProgress(v.all, v.blind);
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
      h("span", { class: "dock-of" }, chips.length ? (run ? p.short : `${chips.length} wartend`) : "", chips.length ? kidBar(v.all, p.text) : null),
      run ? h("span", { class: "dock-round muted" }, v.blind ? "Stand unbekannt" : v.round) : null,
      // narrow screens: the row opens the run panel (chevron, design v25)
      icon(ICON.chevRight, "dock-open"),
      run ? waitingNote(id, run, "dock-wait") : null,
      // a machine without a run but with tickets waiting: start right from its row
      !run && chips.length
        ? h("button", { class: "btn small primary dock-start", "data-start": true, title: "Lauf auf diesem Rechner starten" }, "▷ Lauf starten")
        : null,
    ),
    h("div", { class: "dock-chips", "data-list": true }, ...(chips.length ? chips.map((c, i) => chipEl(c, i, v)) : [h("p", { class: "empty" }, "Leer – Ticket hierher ziehen")])),
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
  const lanes = d.lanes.map((lane) => ({ lane, v: laneView(d, lane, keys) })).filter((x) => x.v.run || x.v.chips.length);
  const live = lanes.filter((x) => x.v.run);
  titleEl.textContent = `Sandcastle · ${live.length} ${live.length === 1 ? "Lauf" : "Läufe"}`;
  root.querySelector(".dock-toggle")?.setAttribute("aria-expanded", String(open));
  root.classList.toggle("closed", !open);
  summaryEl.textContent = open ? "" : live.map((x) => `${x.lane.server.label} ${childProgress(x.v.all, x.v.blind).short}`).join(" · ");
  bodyEl.hidden = !open;
  if (open)
    reconcile(
      bodyEl,
      lanes.length
        ? lanes.map((x) => rowEl(x.lane, x.v))
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

/** Stories whose children the user folded in or out (`<server>|<key>`); the rest follow their activity. */
const folds = new Map<string, boolean>();

function childRow(server: string, run: Run | undefined, k: ChildInfo): HTMLElement {
  const d = lastDerived;
  const title = run?.issues.find((i) => i.n === k.n)?.title ?? d?.issues.get(k.n)?.title ?? "";
  return h(
    "li",
    { class: "run-kid", "data-status": k.status },
    h(
      "div",
      { class: "run-kid-row" },
      h("span", { class: "run-kid-n" }, `#${k.n}`),
      h("span", { class: "run-kid-title", title }, title, isWorking(k) && k.since ? h("span", { class: "run-kid-since" }, `seit ${since(k.since)}`) : null),
      h("span", { class: "run-kid-st", "data-status": k.status }, childLabel(k)),
      run && isWorking(k) ? h("button", { class: "link", "aria-label": `Log von #${k.n}`, onclick: () => openLog(server, run, k.n) }, "Log") : null,
    ),
    k.status === "failed" && k.reason ? h("p", { class: "run-kid-reason", title: k.reason }, k.reason) : null,
  );
}

function ticketBlock(server: string, v: LaneView, c: DockChip, i: number): HTMLElement {
  const d = lastDerived;
  const { run, chips } = v;
  const deps = d ? dependsOn(chips, c, (n) => d.issues.get(n)?.blockedBy ?? []) : [];
  const kids = v.kids.get(c.key) ?? [];
  const s = storySummary(kids, v.step);
  const waiting = c.phase === "queued";
  const fold = `${server}|${c.key}`;
  const open = folds.get(fold) ?? (s.activity === "working" || s.activity === "merging" || s.activity === "ready");
  const toggle = () => {
    folds.set(fold, !open);
    sideSig = "";
    if (lastDerived) renderRunSide(lastDerived);
  };
  const up = moveChip(chips, c.key, -1);
  const down = moveChip(chips, c.key, 1);
  return h(
    "div",
    { class: "run-ticket", "data-activity": s.activity },
    deps.length ? h("div", { class: "dep-note muted" }, icon(ICON.cornerDownRight, "dep-ico"), `baut auf ${deps.join(", ")}`) : null,
    h(
      "div",
      { class: "run-ticket-top" },
      h("span", { class: "pos" }, i + 1),
      h("span", { class: "run-ticket-name" }, h("b", {}, c.key), " ", summaryOf(c.key)),
      !waiting && s.activity !== "done" ? icon(ICON.lock, "lock") : null,
    ),
    h(
      "div",
      { class: "run-ticket-st" },
      h("b", { class: "run-ticket-n" }, v.blind ? s.count : `${s.count} gemergt`),
      kids.length ? kidBar(kids, `${c.key}: ${s.count}${v.blind ? "" : " gemergt"}, ${s.label}`) : null,
      h("span", { class: "run-ticket-act", "data-activity": s.activity }, s.roles.length ? rolesEl(s.roles) : s.label),
    ),
    kids.length
      ? h(
          "button",
          { class: "run-fold", "aria-expanded": String(open), onclick: toggle },
          icon(open ? ICON.chevDown : ICON.chevRight, "fold-ico"),
          open ? "Kinder ausblenden" : `${kids.length} ${kids.length === 1 ? "Kind" : "Kinder"} anzeigen`,
        )
      : null,
    open ? h("ul", { class: "run-kids" }, ...kids.map((k) => childRow(server, run, k))) : null,
    waiting
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

/** The round box: „Runde 3 von max. 60 · jetzt: …“, Planer wählt · Kinder bauen · Merge, children merged. */
function roundBox(v: LaneView): HTMLElement {
  const p = childProgress(v.all, v.blind);
  const pass = v.run?.flow?.pass;
  const now = ROUND_STEPS.findIndex((s) => s.id === v.step);
  return h(
    "div",
    { class: "run-round", role: "status", "data-unknown": v.blind ? "true" : null },
    h("p", { class: "run-round-text" }, pass && pass.n > 1 ? `${v.round} · Durchgang ${pass.n}` : v.round),
    v.steps
      ? h(
          "ol",
          { class: "run-round-steps", "aria-hidden": "true" },
          ...ROUND_STEPS.map((s, i) => h("li", { "data-state": i < now ? "done" : i === now ? "active" : "todo" }, s.label)),
        )
      : null,
    v.all.length ? h("div", { class: "run-round-progress" }, h("span", { class: "muted" }, p.text), kidBar(v.all, p.text)) : null,
  );
}

function renderRunSide(d: Derived): void {
  if (!sideServer || !sidePanel) return;
  const server = sideServer;
  const lane = d.lanes.find((l) => l.server.id === server);
  const v: LaneView = lane ? laneView(d, lane, ticketKeys()) : { run: undefined, blind: false, chips: [], kids: new Map(), all: [], step: null, round: "", steps: false };
  const { run, chips } = v;
  const titles = v.all.map((k) => run?.issues.find((i) => i.n === k.n)?.title ?? d.issues.get(k.n)?.title);
  const sig = JSON.stringify([server, run, chips, [...v.kids], titles, [...folds], chips.map((c) => summaryOf(c.key)), Math.floor(Date.now() / 60_000)]);
  if (sig === sideSig) return;
  sideSig = sig;
  const label = lane?.server.label ?? server;
  const parallel = run?.config.parallel;
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
            h("dd", {}, run.config.agentLabel || run.config.agent || "–", parallel ? h("span", { class: "muted" }, ` · ${parallel} ${parallel === 1 ? "Kind" : "Kinder"} gleichzeitig`) : null),
            h("dt", {}, "Gestartet"),
            h("dd", {}, run.startedAt ? `vor ${since(run.startedAt)}` : "–"),
            h("dt", {}, "Pull Request"),
            h("dd", {}, run.pr && run.slug ? h("button", { class: "link", onclick: () => openExternal(`https://github.com/${run.slug}/pull/${run.pr}`) }, `#${run.pr}`) : "noch keiner"),
          )
        : h("p", { class: "muted" }, chips.length ? "Diese Tickets warten auf den nächsten Lauf." : "Keine Tickets eingereiht."),
      run ? roundBox(v) : null,
      run ? waitingNote(server, run, "run-wait") : null,
      run
        ? h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => openLog(server, run, null) }, "Protokoll öffnen"), stopButton(server, run))
        : h("div", { class: "btn-row" }, h("button", { class: "btn primary", onclick: () => newRunModal(server) }, "Lauf starten")),
      h("h3", { class: "run-side-h" }, `${run ? "Stories in Reihenfolge" : "Warteschlange"} (${chips.length})`),
      ...chips.map((c, i) => ticketBlock(server, v, c, i)),
    ),
  );
}
