/**
 * Sandcastle board – head bar (project, Tickets | Werkbank, Board | Läufe, machine chips, drift counter, Wächter,
 * reload), data loading and polling. First paint comes from the cache of the last visit; every source (servers,
 * each machine's projects/status/queue, the GitHub board, the JIRA board) then loads on its own and re-renders when
 * it arrives – nothing waits for the slowest machine.
 */
import { writing } from "./actions";
import { api, type HostTheme, hostTheme, initToken, sc, servers, hostEvents } from "./api";
import { dragging } from "./drag";
import { fill, h, reconcile } from "./dom";
import { readHash } from "./filter";
import { dropOpen, keyProject, type OpenTarget, parseOpen, readOpen, ticketOfIssue } from "./grill";
import { pumpGrills } from "./grillqueue";
import { clearTicketCards } from "./views/ticketcard";
import { openTicketSide, renderTicketLive } from "./views/ticketside";
import { renderTickets, ticketsView, ticketsVisible } from "./views/tickets";
import { guardControl, loadGuard } from "./views/guard";
import {
  cacheGet,
  cacheSet,
  errorText,
  hooks,
  laneServers,
  loadPrefs,
  prefGet,
  prefSet,
  projects,
  state,
  toast,
  type Mode,
  type View,
} from "./state";
import type { BoardData, JiraBoardData, Project, QueueState, Server, Status } from "./types";
import { boardView, boardVisible, newIssue, renderBoard } from "./views/board";
import { clearCards } from "./views/cards";
import { activeTokens, filterBar, setQuery, toggleToken } from "./views/filterbar";
import { followLog, renderRuns, runsView, STATUS_TEXT } from "./views/runs";
import { closeSidebar, openIssue, renderLive } from "./views/sidebar";
import { applyTheme } from "./theme";

initToken();
await loadPrefs();

// Hollr's palette: the last one at once (no flash), then the live one, then every switch while open
applyTheme(prefGet<HostTheme>("theme"));
const useTheme = (t: HostTheme | null) => {
  if (applyTheme(t)) prefSet("theme", t);
};
hostEvents.onTheme = useTheme;
hostEvents.onOpen = (ticket, repo) => {
  const t = parseOpen(ticket, repo);
  if (t) openTicket(t);
};
hostTheme().then(useTheme);

const projectSelect = h("select", { class: "project", "aria-label": "Projekt" });
const ticketsTab = h("button", { class: "tab", onclick: () => showMode("tickets") }, "Tickets");
const werkbankTab = h("button", { class: "tab", onclick: () => showMode("werkbank") }, "Werkbank");
const boardTab = h("button", { class: "tab", onclick: () => show("board") }, "Board");
const runsTab = h("button", { class: "tab", onclick: () => show("runs") }, "Läufe");
const chips = h("div", { class: "mchips" });
const driftChip = h("button", { class: "drift-chip", hidden: true, title: "Nur Tickets mit Abweichungen zeigen", onclick: () => toggleDrift() });
const reload = h("button", { class: "btn icon", title: "Neu laden", "aria-label": "Neu laden", onclick: () => refreshAll(true) }, "↻");
const newIssueBtn = h("button", { class: "btn primary", "aria-label": "Neues Issue", onclick: () => newIssue() }, "+", h("span", { class: "wide-only" }, " Neues Issue"));
// JIRA has no create API here yet: the design's button, disabled
const newTicketBtn = h("button", { class: "btn primary", "aria-label": "Neues Ticket", disabled: true, title: "kommt noch" }, "+", h("span", { class: "wide-only" }, " Neues Ticket"));
const bar = filterBar(() => (state.mode === "tickets" ? ticketsVisible() : boardVisible()), [newIssueBtn, newTicketBtn]);
const werkbankHost = h("div", { class: "view" });
const ticketsHost = h("div", { class: "view" });
const boardHost = h("div", { class: "view" }, bar.el, ticketsHost, werkbankHost);
const runsHost = h("div", { class: "view" });
const main = h("main", {}, boardHost, runsHost);

document.body.append(
  h(
    "header",
    { class: "head" },
    h("span", { class: "brand" }, "Sandcastle"),
    projectSelect,
    h("div", { class: "tabs" }, ticketsTab, werkbankTab),
    h("div", { class: "tabs" }, boardTab, runsTab),
    chips,
    driftChip,
    guardControl(),
    h("span", { class: "grow" }),
    reload,
  ),
  main,
);

/** The drift counter sets (or drops) the `drift:` token and shows the Tickets. */
function toggleDrift(): void {
  const on = activeTokens().some((t) => t.kind === "drift");
  toggleToken("drift:");
  if (!on) showMode("tickets");
}

// ---- cache → first paint

state.servers = cacheGet<Server[]>("servers") ?? [];
state.localProjects = cacheGet<Project[]>("localProjects") ?? [];
for (const [k, v] of Object.entries(cacheGet<Record<string, Project[]>>("machineProjects") ?? {})) state.machineProjects.set(k, v);
for (const [k, v] of Object.entries(cacheGet<Record<string, Status>>("statuses") ?? {})) state.statuses.set(k, v);
state.view = prefGet<View>("view") ?? "board";
state.mode = prefGet<Mode>("mode") ?? "tickets";
const REFRESH = "__refresh__";

function useSlug(slug: string): void {
  state.slug = slug;
  state.board = cacheGet<BoardData>(`board.${slug}`);
  state.jira = cacheGet<JiraBoardData>(`jira.${slug}`);
  state.jiraError = null;
  state.olderClosed = [];
  state.closedOlder = 0;
  state.queues = new Map(Object.entries(cacheGet<Record<string, QueueState>>(`queues.${slug}`) ?? {}));
  prefSet("slug", slug);
  clearCards();
  clearTicketCards();
}

function pickSlug(): void {
  const list = projects();
  const want = state.slug || prefGet<string>("slug") || "";
  const slug = list.find((p) => p.slug === want)?.slug ?? list[0]?.slug ?? "";
  if (slug === state.slug) return;
  useSlug(slug);
  loadBoard();
  loadJira();
  loadQueues();
}

// ---- rendering (coalesced into one frame)

let frame = 0;
hooks.render = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderHead();
    if (state.view === "board") {
      if (state.mode === "tickets") renderTickets();
      else renderBoard();
      bar.update();
    } else renderRuns();
    renderTicketLive();
    renderLive();
    if (pendingOpen) tryOpen();
  });
};

let projectSig = "";
function renderHead(): void {
  const list = projects();
  const sig = JSON.stringify([list.map((p) => p.slug), state.slug]);
  if (sig !== projectSig) {
    projectSig = sig;
    const names = list.map((p) => p.name);
    fill(
      projectSelect,
      ...(list.length ? [] : [h("option", { value: "" }, "Projekte werden gesucht …")]),
      ...list.map((p) => h("option", { value: p.slug }, names.indexOf(p.name) !== names.lastIndexOf(p.name) ? `${p.name} (${p.slug})` : p.name)),
      h("option", { value: REFRESH }, "↻ Projekte neu suchen …"),
    );
    projectSelect.value = state.slug;
  }
  // one chip for every live run on every machine (all projects); „wartet auf dich“ wins the colour
  const live = state.servers.flatMap((s) => (state.statuses.get(s.id)?.runs ?? []).filter((r) => r.status !== "ended").map((r) => ({ s, r })));
  const machines = new Set(live.map((x) => x.s.id)).size;
  const status = live.find((x) => x.r.status === "waiting")?.r.status ?? live[0]?.r.status;
  const n = live.length;
  const text = n ? `● ${n} ${n === 1 ? "Lauf" : "Läufe"}${machines > 1 ? ` auf ${machines} Maschinen` : ` auf ${live[0]?.s.label}`}` : "○ Keine Läufe";
  const title = live.map((x) => `${x.s.label}: ${x.r.project} · ${x.r.branch} · ${STATUS_TEXT[x.r.status]} · ${x.r.progress.percent} %`).join("\n");
  reconcile(chips, [h("button", { class: `mchip ${status ? `st-${status}` : "idle"}`, title, onclick: () => show("runs") }, h("span", { class: "chip-long" }, text), h("span", { class: "chip-short" }, n ? `● ${n} ${n === 1 ? "Lauf" : "Läufe"}` : "○ 0"))]);
  // the drift counter: actionable drift items of the project's tickets
  const drift = state.jira?.counts.drift ?? 0;
  driftChip.hidden = !drift;
  driftChip.classList.toggle("on", activeTokens().some((t) => t.kind === "drift"));
  const driftText = `⚠ ${drift} ${drift === 1 ? "Abweichung" : "Abweichungen"}`;
  if (driftChip.textContent !== driftText) driftChip.textContent = driftText;
  driftChip.title = `${state.jira?.counts.tickets ?? 0} Tickets mit Abweichungen zeigen (drift:)`;
}

function show(view: View): void {
  state.view = view;
  prefSet("view", view);
  boardTab.classList.toggle("active", view === "board");
  runsTab.classList.toggle("active", view === "runs");
  if (view === "runs" && !runsHost.firstChild) runsHost.append(runsView());
  boardHost.hidden = view !== "board";
  runsHost.hidden = view !== "runs";
  if (view === "runs") closeSidebar();
  showModeHosts();
  hooks.render();
  tick(true);
}
hooks.show = show;

/** Tickets (JIRA) or Werkbank (GitHub) inside „Board“; each view is built on first show. */
function showModeHosts(): void {
  const mode = state.mode;
  ticketsTab.classList.toggle("active", mode === "tickets");
  werkbankTab.classList.toggle("active", mode === "werkbank");
  if (mode === "tickets" && !ticketsHost.firstChild) ticketsHost.append(ticketsView());
  if (mode === "werkbank" && !werkbankHost.firstChild) werkbankHost.append(boardView());
  ticketsHost.hidden = mode !== "tickets";
  werkbankHost.hidden = mode !== "werkbank";
  newIssueBtn.hidden = mode !== "werkbank";
  newTicketBtn.hidden = mode !== "tickets";
}

function showMode(mode: Mode): void {
  state.mode = mode;
  prefSet("mode", mode);
  if (state.view !== "board") show("board");
  else {
    showModeHosts();
    hooks.render();
  }
}
hooks.showMode = showMode;
hooks.openTicket = (key: string) => {
  if (!key) return;
  showMode("tickets");
  openTicketSide(key);
};

projectSelect.addEventListener("change", async () => {
  if (projectSelect.value === REFRESH) {
    projectSelect.value = state.slug;
    toast("Projekte werden neu gesucht …", "info");
    await loadProjects(true);
    return;
  }
  closeSidebar();
  useSlug(projectSelect.value);
  hooks.render();
  last.board = 0;
  last.jira = 0;
  last.queues = 0;
  tick(true);
});

// ---- loading

const inflight = new Set<string>();
/** Runs a load once at a time per key; errors become toasts unless `quiet`. */
async function once(key: string, fn: () => Promise<void>, quiet = false): Promise<void> {
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    await fn();
  } catch (err) {
    if (!quiet) toast(errorText(err));
  } finally {
    inflight.delete(key);
  }
}

const saveMap = <T>(key: string, m: Map<string, T>) => cacheSet(key, Object.fromEntries(m));

async function loadServers(): Promise<void> {
  await once("servers", async () => {
    const list = await servers();
    // data of machines no longer paired (or ids from the other channel) would show as ghost lanes
    const ids = new Set(list.map((s) => s.id));
    for (const m of [state.statuses, state.machineProjects, state.queues, state.statusErrors])
      for (const k of m.keys()) if (!ids.has(k)) m.delete(k);
    state.servers = list;
    cacheSet("servers", list);
    hooks.render();
  });
}

async function loadMachineProjects(s: Server, refresh = false): Promise<void> {
  if (!s.online) return;
  await once(`projects:${s.id}`, async () => {
    try {
      state.machineProjects.set(s.id, await sc.projects(s.id, refresh));
      state.statusErrors.delete(s.id);
    } catch (err) {
      state.machineProjects.set(s.id, []);
      state.statusErrors.set(s.id, `Projekte: ${errorText(err)}`);
    }
    saveMap("machineProjects", state.machineProjects);
    // this machine may have become a lane of the selected project
    if (state.slug && !state.queues.has(s.id)) loadQueues();
    pickSlug();
    hooks.render();
  });
}

async function loadProjects(refresh = false): Promise<void> {
  const local = once("localProjects", async () => {
    const { projects: list } = await api<{ projects: Project[] }>(`/api/projects${refresh ? "?refresh=1" : ""}`);
    state.localProjects = list;
    state.localFresh = true;
    cacheSet("localProjects", list);
    pickSlug();
    hooks.render();
  });
  await Promise.all([local, ...state.servers.map((s) => loadMachineProjects(s, refresh))]);
  last.projects = Date.now();
}

async function loadStatus(s: Server): Promise<void> {
  if (!s.online) return;
  await once(
    `status:${s.id}`,
    async () => {
      try {
        state.statuses.set(s.id, await sc.status(s.id));
        pumpGrills();
        if (state.statusErrors.get(s.id)?.startsWith("Status")) state.statusErrors.delete(s.id);
      } catch (err) {
        state.statusErrors.set(s.id, `Status: ${errorText(err)}`);
      }
      saveMap("statuses", state.statuses);
      hooks.render();
    },
    true,
  );
}
hooks.reloadStatus = () => Promise.all(state.servers.map(loadStatus)).then(() => {});

/** `full`: the reload button – the server fetches everything again (new labels, users), not only changed issues. */
async function loadBoard(full = false): Promise<void> {
  const slug = state.slug;
  if (!slug) return;
  await once(`board:${slug}`, async () => {
    const since = state.board?.etag ? `&since=${encodeURIComponent(state.board.etag)}` : "";
    const res = await api<BoardData | { same: true }>(`/api/board?slug=${encodeURIComponent(slug)}${since}${full ? "&refresh=1" : ""}`);
    last.board = Date.now();
    if (slug === state.slug) freshBoard = slug;
    if (slug !== state.slug || "same" in res || writing() || dragging()) return;
    state.board = res;
    cacheSet(`board.${slug}`, res);
    // the server refreshes a stale answer in the background: ask again soon
    if (res.stale) last.board = Date.now() - 12_000;
    hooks.render();
  });
}
hooks.reloadBoard = loadBoard;

/** The JIRA board with etag; `full` refetches JIRA (refresh=1). 409 jira-missing → the Tickets view says so. */
async function loadJira(full = false): Promise<void> {
  const slug = state.slug;
  const p = projects().find((x) => x.slug === slug);
  if (!slug || !p?.jira.projectKey) return;
  await once(
    `jira:${slug}`,
    async () => {
      const since = state.jira?.etag ? `&since=${encodeURIComponent(state.jira.etag)}` : "";
      try {
        const res = await api<JiraBoardData | { same: true }>(`/api/jira/board?slug=${encodeURIComponent(slug)}${since}${full ? "&refresh=1" : ""}`);
        last.jira = Date.now();
        state.jiraMissing = false;
        if (slug !== state.slug) return;
        state.jiraError = null;
        freshJira = slug;
        if ("same" in res || writing() || dragging()) {
          hooks.render();
          return;
        }
        state.jira = res;
        cacheSet(`jira.${slug}`, res);
        if (res.stale) last.jira = Date.now() - 12_000;
      } catch (err) {
        const text = errorText(err);
        if (text === "jira-missing") {
          state.jiraMissing = true;
          state.jira = null;
        } else if (slug === state.slug) state.jiraError = text;
        if (slug === state.slug) freshJira = slug;
      }
      hooks.render();
    },
    true,
  );
}
hooks.reloadJira = () => loadJira();

async function loadQueues(): Promise<void> {
  const slug = state.slug;
  await Promise.all(
    laneServers().map((s) =>
      once(`queue:${s.id}:${slug}`, async () => {
        const q = await sc.queue(s.id, slug);
        if (slug !== state.slug || writing() || dragging()) return;
        state.queues.set(s.id, q);
        saveMap(`queues.${slug}`, state.queues);
        hooks.render();
      }, true),
    ),
  );
  last.queues = Date.now();
}
hooks.reloadQueues = loadQueues;

// ---- polling: only what is visible, only while the page is visible

const last = { servers: 0, projects: 0, status: 0, board: 0, jira: 0, queues: 0, guard: 0 };

function tick(force = false, full = false): void {
  if (document.hidden) return;
  const now = Date.now();
  if (now - last.servers > 60_000) {
    last.servers = now;
    loadServers().then(() => {
      for (const s of state.servers) {
        if (!state.machineProjects.has(s.id)) loadMachineProjects(s);
        if (!state.statuses.has(s.id)) loadStatus(s);
      }
    });
  }
  if (now - last.projects > 10 * 60_000) {
    last.projects = now;
    loadProjects();
  }
  if (force || now - last.status >= 4000) {
    last.status = now;
    hooks.reloadStatus();
  }
  if (state.view === "board" && (force || now - last.board >= 15_000)) {
    last.board = now;
    loadBoard(full);
  }
  if (state.view === "board" && (force || now - last.jira >= 15_000)) {
    last.jira = now;
    loadJira(full);
  }
  if (state.view === "board" && (force || now - last.guard >= 30_000)) {
    last.guard = now;
    loadGuard();
  }
  if (state.view === "board" && (force || now - last.queues >= 15_000)) {
    last.queues = now;
    loadQueues();
  }
}

/** Reload button / visibility return: everything now, projects re-scanned only on the button. */
function refreshAll(button = false): void {
  last.servers = 0;
  if (button) last.projects = 0;
  reload.classList.add("spin");
  setTimeout(() => reload.classList.remove("spin"), 600);
  tick(true, button);
}

setInterval(() => tick(), 1000);
setInterval(() => {
  if (!document.hidden && state.view === "runs") followLog();
}, 1500);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAll();
});

// ---- deep link `open=KEY:n` / `:n` / `KEY:` (+ `repo=owner/name`) and Hollr's `open` event („Im Board zeigen“,
// tapped ticket keys and #n in a session)

let pendingOpen: OpenTarget | null = null;
/** the project switch is decided once per link, as soon as projects are known */
let openSwitched = false;
/** slug whose board answered from the network since the page opened (a key-only link may then give up) */
let freshBoard = "";
/** slug whose JIRA board was asked over the network since the page opened (a `:n` link then stops waiting) */
let freshJira = "";

function openTicket(t: OpenTarget): void {
  pendingOpen = t;
  openSwitched = false;
  tryOpen();
}

/**
 * Switches to the link's project (`repo=` slug, else by JIRA project key, else stays) and opens its details once it
 * can. `:n` opens the JIRA ticket whose GitHub family holds n (Tickets view), any other issue in the Werkbank.
 */
function tryOpen(): void {
  const t = pendingOpen;
  if (!t) return;
  if (!openSwitched) {
    const list = projects();
    if (!list.length) return;
    const key = t.key;
    const repo = t.repo?.toLowerCase();
    const target = repo
      ? list.find((p) => p.slug.toLowerCase() === repo)
      : key
        ? list.find((p) => p.jira.projectKey === keyProject(key))
        : undefined;
    if (repo && !target) {
      // the cached list may predate a checkout (or be an empty scan): only this machine's fresh answer may say no
      if (!state.localFresh) return;
      pendingOpen = null;
      toast(`Projekt ${t.repo} gibt es auf diesem Rechner nicht.`);
      return;
    }
    openSwitched = true;
    if (target && target.slug !== state.slug) {
      closeSidebar();
      useSlug(target.slug);
      last.board = 0;
      last.jira = 0;
      last.queues = 0;
    }
    // KEY:n opens the Werkbank issue; `:n` decides below (ticket family or Werkbank); KEY: the ticket
    if (t.n !== null && t.key) showMode("werkbank");
    else if (state.view !== "board") show("board");
    else tick(true);
  }
  if (t.n !== null && !t.key) {
    const n = t.n;
    const key = state.jira ? ticketOfIssue(state.jira.tickets, n) : null;
    if (key) {
      pendingOpen = null;
      hooks.openTicket(key);
      return;
    }
    // not in the cached families: wait for this page's own JIRA answer before falling back to the issue
    const p = projects().find((x) => x.slug === state.slug);
    if (p?.jira.projectKey && freshJira !== state.slug) return;
    pendingOpen = null;
    showMode("werkbank");
    openIssue(n);
    return;
  }
  if (t.n !== null) {
    pendingOpen = null;
    openIssue(t.n);
    return;
  }
  if (state.jira?.tickets.some((x) => x.key === t.key) && t.key) {
    pendingOpen = null;
    hooks.openTicket(t.key);
    return;
  }
  const issue = state.board?.issues.find((i) => i.jira === t.key);
  if (issue) {
    pendingOpen = null;
    showMode("werkbank");
    openIssue(issue.number);
  } else if (freshBoard === state.slug) {
    pendingOpen = null;
    toast(`${t.key} ist in diesem Board nicht zu finden.`);
  }
}

const initial = readHash(location.hash) || prefGet<string>("filter") || "";
const linked = readOpen(location.hash);
if (linked) history.replaceState(null, "", location.pathname + location.search + dropOpen(location.hash));
pickSlug();
show(state.view);
if (initial) setQuery(initial);
if (linked) openTicket(linked);
