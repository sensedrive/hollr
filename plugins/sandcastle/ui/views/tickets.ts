/**
 * „Tickets“: the JIRA tickets of the project as cards, one column per JIRA status in workflow order, plus the
 * derived „Zu grillen“ (Selected without a story on GitHub) before Selected and the Sandcastle machine lanes after it
 * (a ticket sits in a lane while one of its children is queued or built there). Dragging onto a status column moves
 * the ticket in JIRA, onto a lane queues its open children on that machine. Built once, updated in place per poll.
 */
import { queueChildren, transitionTicket } from "../actions";
import { openExternal } from "../api";
import { derive, type Derived, type Lane } from "../derive";
import { dragging, enableDrag } from "../drag";
import { fill, h, reconcile } from "../dom";
import { currentStep, GRILL_STEP_COUNT, isLiveGrill } from "../grill";
import { branchColour, isBusy, shortBranch } from "../model";
import { compileTerms } from "../query";
import { hooks, prefGet, prefSet, serverLabel, state } from "../state";
import {
  buildLine,
  compileTickets,
  dropStatus,
  LANE_PREFIX,
  memberPhase,
  statusColumn,
  type TicketColumn,
  ticketColumns,
  ticketLane,
} from "../tickets";
import type { JiraTicket, Phase } from "../types";
import { closedLanes, isNarrow, type LaneEl, laneClick, laneEl, longPress } from "./board";
import { filterTerms } from "./filterbar";
import { cardGrill } from "./grilling";
import { showMenu } from "./menu";
import { type TicketCardInfo, ticketCardEl } from "./ticketcard";
import { openTicketSide } from "./ticketside";

interface ColumnEls {
  el: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
}

const colEls = new Map<string, ColumnEls>();
const laneEls = new Map<string, LaneEl>();
const groupEls = new Map<string, HTMLElement>();
let root: HTMLElement | null = null;
let columnsEl: HTMLElement;
let segsEl: HTMLElement;
let noticeEl: HTMLElement;
let staleEl: HTMLElement;
let infoEl: HTMLElement;
let seg = "";
let visible = { keys: [] as (string | null)[], count: 0 };
/** keys and count of the visible cards (the JIRA link button) */
export const ticketsVisible = () => visible;

/** the column definitions of the last render (drop and menu targets) */
let columns: TicketColumn[] = [];

export function ticketsView(): HTMLElement {
  if (root) return root;
  seg = prefGet<string>("tseg") ?? "";
  segsEl = h("div", { class: "segs", role: "tablist" });
  columnsEl = h("div", { class: "columns tcolumns" });
  noticeEl = h("div", { class: "notice-host", hidden: true });
  staleEl = h("div", { class: "stale", hidden: true });
  infoEl = h("div", { class: "qf-info small muted", hidden: true });
  root = h("div", { class: "board" }, infoEl, staleEl, noticeEl, segsEl, columnsEl);
  root.addEventListener("click", (e) => {
    const t = e.target as Element;
    const link = t.closest<HTMLElement>("[data-url]");
    if (link) {
      e.preventDefault();
      openExternal(link.dataset.url ?? "");
      return;
    }
    const card = t.closest<HTMLElement>("[data-card]");
    if (card) openTicketSide(card.dataset.card ?? "");
    laneClick(t);
  });
  root.addEventListener("keydown", (e) => {
    const target = e.target as Element;
    const card = target.closest<HTMLElement>("[data-card]");
    // Enter on a PR link is its click
    if (card && e.key === "Enter" && !target.closest("[data-url]")) openTicketSide(card.dataset.card ?? "");
  });
  enableDrag(columnsEl, { canDrag: () => !isNarrow(), ordered: () => false, onDrop: (key, to) => onDrop(key, to) });
  longPress(columnsEl, cardMenu);
  matchMedia("(max-width: 699px)").addEventListener("change", () => renderTickets());
  return root;
}

const selectedState = (d: Derived) => d.project?.jira.states.selected ?? null;
const ticketOf = (key: string) => state.jira?.tickets.find((t) => t.key === key);

function onDrop(key: string, to: string): void {
  const t = ticketOf(key);
  if (!t) return;
  if (to.startsWith(LANE_PREFIX)) {
    queueChildren(key, to.slice(LANE_PREFIX.length));
    return;
  }
  const status = dropStatus(to, t, selectedState(derive()));
  if (status) transitionTicket(key, status);
}

/** Long press / right click: move to a status, queue the children on a machine, details. */
function cardMenu(key: string): void {
  const t = ticketOf(key);
  if (!t) return;
  const d = derive();
  const selected = selectedState(d);
  const here = statusColumn(t, selected);
  const items = [
    ...columns
      .filter((c) => c.kind !== "lanes" && c.key !== here)
      .flatMap((c) => {
        const status = dropStatus(c.key, t, selected);
        return status ? [{ label: `→ ${c.name}`, disabled: false, run: () => transitionTicket(key, status) }] : [];
      }),
    ...d.lanes.map((l) => ({ label: `→ Sandcastle auf ${l.server.label} (Kinder einreihen)`, disabled: !t.family.children.length, run: () => queueChildren(key, l.server.id) })),
    { label: "Details", disabled: false, run: () => openTicketSide(key) },
  ];
  showMenu(`${t.key} ${t.summary}`, items);
}

function columnEl(c: TicketColumn): ColumnEls {
  let el = colEls.get(c.key);
  if (!el) {
    const count = h("span", { class: "count" });
    const list = h("div", { class: "list", "data-list": true });
    const section = h("section", { class: `column tcol-${c.kind}${c.kind === "status" ? ` cat-${c.status.category}` : ""}` }, h("header", {}, h("span", {}, c.name), count));
    if (c.kind === "lanes") section.classList.add("col-queue");
    else section.dataset.column = c.key;
    section.append(list);
    el = { el: section, count, list };
    colEls.set(c.key, el);
  }
  return el;
}

const PHASE_RANK: Phase[] = ["reviewing", "building", "failed", "no-commits", "planned", "merged", "queued"];

/** What a card shows of the ticket's GitHub family: build line, run phase, grill. */
function cardInfo(d: Derived, t: JiraTicket, pos?: number): TicketCardInfo {
  const f = t.family;
  let run: { machine: string; percent: number } | null = null;
  const pr = t.prs[0] ?? null;
  const phases: Phase[] = [];
  const children = f.children.map((c) => {
    const tr = d.runs.get(c.n);
    if (tr && tr.run.status !== "ended") {
      run ??= { machine: serverLabel(tr.server), percent: tr.run.progress.percent };
      phases.push(tr.issue.phase);
    }
    return { n: c.n, seg: memberPhase(c, tr?.issue.phase) };
  });
  const tg = f.grill ? d.grills.get(f.grill.n) : undefined;
  const grill = tg && isLiveGrill(tg.grill) ? `Grill ${currentStep(tg.grill)}/${GRILL_STEP_COUNT}` : null;
  return {
    t,
    pos,
    build: buildLine({ story: f.story?.n ?? null, children, run, grill, pr }),
    phase: PHASE_RANK.find((p) => phases.includes(p)),
    grill: f.grill ? cardGrill(d, f.grill.n) : undefined,
    busy: phases.some((p) => isBusy(p)),
  };
}

function groupEl(key: string, dot: string | null, text: string): HTMLElement {
  let el = groupEls.get(key);
  if (!el) {
    el = h("div", { class: "lane-group" });
    groupEls.set(key, el);
  }
  const sig = `${dot}|${text}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    fill(el, dot ? h("span", { class: "dot", style: `background:${dot}` }) : null, text);
  }
  return el;
}

/** Lane body: tickets with children in a live run here (per run), then the ones whose children wait here. */
function laneCards(d: Derived, lane: Lane, tickets: { t: JiraTicket; pos: number }[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const sorted = [...tickets].sort((a, b) => a.pos - b.pos);
  const runOf = (t: JiraTicket) =>
    t.family.children.map((c) => d.runs.get(c.n)).find((tr) => tr && tr.server === lane.server.id && tr.run.status !== "ended")?.run;
  const placed = new Set<string>();
  let n = 0;
  for (const r of lane.runs.filter((x) => x.status !== "ended")) {
    const mine = sorted.filter((x) => runOf(x.t) === r);
    if (!mine.length) continue;
    out.push(groupEl(`${lane.server.id}|${r.id}`, branchColour(r.branch), `Im Lauf ${shortBranch(r.branch)}`));
    for (const x of mine) {
      placed.add(x.t.key);
      out.push(ticketCardEl(cardInfo(d, x.t, ++n)));
    }
  }
  const next = sorted.filter((x) => !placed.has(x.t.key));
  if (next.length && out.length) out.push(groupEl(lane.server.id, null, "Als Nächstes"));
  for (const x of next) out.push(ticketCardEl(cardInfo(d, x.t, ++n)));
  return out;
}

const empty = (text: string) => h("p", { class: "empty" }, text);

function notice(title: string, text: string, actions: HTMLElement[]): HTMLElement {
  return h("div", { class: "notice" }, h("b", {}, title), h("p", { class: "notice-text" }, text), actions.length ? h("div", { class: "btn-row" }, ...actions) : null);
}

export function renderTickets(): void {
  if (!root || dragging()) return;
  const d = derive();
  const jira = state.jira;
  visible = { keys: [], count: 0 };
  const toWerkbank = () => h("button", { class: "btn", onclick: () => hooks.showMode("werkbank") }, "Zur Werkbank wechseln");
  let note: HTMLElement | null = null;
  if (state.jiraMissing)
    note = notice(
      "Kein JIRA-Zugang hinterlegt",
      "JIRA-Zugang in Hollr › Einstellungen › Integrationen eintragen. Dann erscheinen die Tickets deines Projekts hier. Die Werkbank mit den GitHub-Issues funktioniert weiter.",
      [toWerkbank()],
    );
  else if (d.project && !d.project.jira.projectKey)
    note = notice(
      "Kein JIRA-Projekt eingerichtet",
      `Projekt ${d.project.name} nennt keinen JIRA-Projektschlüssel (.lul-workr.json › jira.projectKey). Die Werkbank funktioniert weiter.`,
      [toWerkbank()],
    );
  else if (!jira && state.jiraError) note = notice("JIRA nicht erreichbar", state.jiraError, [toWerkbank()]);
  const sig = note?.textContent ?? "";
  if (noticeEl.dataset.sig !== sig) {
    noticeEl.dataset.sig = sig;
    fill(noticeEl, note);
  }
  noticeEl.hidden = !note;
  if (note || !jira) {
    columnsEl.hidden = true;
    segsEl.hidden = true;
    staleEl.hidden = true;
    infoEl.hidden = true;
    if (!note) {
      noticeEl.hidden = false;
      fill(noticeEl, h("p", { class: "empty" }, "Tickets laden …"));
      noticeEl.dataset.sig = "loading";
    }
    return;
  }
  columnsEl.hidden = false;

  const selected = selectedState(d);
  columns = ticketColumns(jira.statuses, selected);
  // sc: asks every machine's live runs, not only the plugin's own machine
  const livePhase = (n: number) => {
    const tr = d.runs.get(n);
    return tr && tr.run.status !== "ended" ? tr.issue.phase : undefined;
  };
  const test = compileTerms(filterTerms(), (tokens) => compileTickets(tokens, livePhase));
  const byCol = new Map<string, JiraTicket[]>(columns.map((c) => [c.key, []]));
  const byLane = new Map<string, { t: JiraTicket; pos: number }[]>(d.lanes.map((l) => [l.server.id, []]));
  const orderOf = (server: string) => d.lanes.find((l) => l.server.id === server)?.order ?? [];
  let shown = 0;
  for (const t of jira.tickets) {
    if (!test(t)) continue;
    shown++;
    const lane = ticketLane(t, d.laneOf, orderOf);
    if (lane && byLane.has(lane.server)) {
      byLane.get(lane.server)?.push({ t, pos: lane.pos });
      continue;
    }
    const key = statusColumn(t, selected);
    let list = byCol.get(key);
    if (!list) {
      // a status the workflow list lacks (sub-task workflows): its own column at the end
      const c: TicketColumn = { key, kind: "status", name: t.status, status: { name: t.status, category: t.category } };
      columns.push(c);
      list = [];
      byCol.set(key, list);
    }
    list.push(t);
  }
  const counts = new Map<string, number>();
  for (const c of columns) {
    const els = columnEl(c);
    if (c.kind === "lanes") {
      const lanes = d.lanes.map((lane) => {
        const el = laneEl(laneEls, d, lane, `${LANE_PREFIX}${lane.server.id}`);
        const items = byLane.get(lane.server.id) ?? [];
        const closed = closedLanes().includes(lane.server.id);
        el.list.hidden = closed;
        if (closed) reconcile(el.list, []);
        else reconcile(el.list, items.length ? laneCards(d, lane, items) : [empty("Leer – Ticket hierher ziehen, um seine Kinder einzureihen")]);
        for (const x of items) visible.keys.push(x.t.key);
        return el.el;
      });
      const n = [...byLane.values()].reduce((s, l) => s + l.length, 0);
      counts.set(c.key, n);
      reconcile(els.list, lanes.length ? lanes : [empty(state.servers.length ? "Kein Rechner hat dieses Projekt ausgecheckt" : "Rechner werden gesucht …")]);
      continue;
    }
    let list = byCol.get(c.key) ?? [];
    if (c.kind === "status" && c.status.category === "done") list = [...list].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    counts.set(c.key, list.length);
    for (const t of list) visible.keys.push(t.key);
    reconcile(els.list, list.length ? list.map((t) => ticketCardEl(cardInfo(d, t))) : [empty("Keine Tickets")]);
  }
  visible.count = visible.keys.length;
  for (const c of columns) columnEl(c).count.textContent = String(counts.get(c.key) ?? 0);
  const narrow = isNarrow();
  if (!columns.some((c) => c.key === seg)) seg = columns.find((c) => c.kind === "lanes")?.key ?? columns[0]?.key ?? "";
  reconcile(columnsEl, columns.map((c) => columnEl(c).el));
  for (const c of columns) columnEl(c).el.classList.toggle("seg-hidden", narrow && c.key !== seg);
  segsEl.hidden = !narrow;
  if (narrow)
    reconcile(
      segsEl,
      columns.map((c) =>
        h("button", { class: `seg-btn${c.key === seg ? " active" : ""}`, role: "tab", onclick: () => pickSeg(c.key) }, shortName(c.name), h("span", { class: "count" }, counts.get(c.key) ?? 0)),
      ),
    );
  const filtered = shown !== jira.tickets.length;
  infoEl.hidden = !filtered;
  infoEl.textContent = filtered ? `${shown} von ${jira.tickets.length} Tickets` : "";
  staleEl.hidden = !jira.refreshError;
  staleEl.textContent = jira.refreshError
    ? `Nicht aktuell – Stand ${new Date(jira.fetchedAt).toLocaleTimeString("de-DE", { timeStyle: "short" })}: ${jira.refreshError}`
    : "";
}

/** „🔖 Selected for Development“ → „Selected“, „🏗 In Progress“ → „In Progress“ for the narrow switcher. */
function shortName(name: string): string {
  const words = name.replace(/^[^\p{L}\d]+/u, "").split(/\s+/);
  return (words[0]?.length ?? 0) <= 3 ? words.slice(0, 2).join(" ") : (words[0] ?? name);
}

function pickSeg(key: string): void {
  seg = key;
  prefSet("tseg", key);
  renderTickets();
  columnsEl.scrollTop = 0;
}
