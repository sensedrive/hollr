/**
 * Läufe – the log view. Left a tree Machine → Run → Ticket for every paired machine, right the log of the selected
 * ticket (implementer · reviewer) or run (planner · merger), following the tail live while the file is written.
 * Narrow: the tree alone; tapping opens the log full screen.
 */
import { hasHost, openExternal, openSession, sc } from "../api";
import { derive } from "../derive";
import { copyText, fill, fmtDate, h, reconcile } from "../dom";
import { branchColour, PHASE_TEXT, segments, since } from "../model";
import { errorText, hooks, prefGet, prefSet, projectOn, serverLabel, state, toast } from "../state";
import { isLiveGrill, modeText, stepText } from "../grill";
import type { Grill, LogFile, Project, Run, RunStatus, Server } from "../types";
import { grillBar, grillLog, grillPill } from "./grilling";

export const STATUS_TEXT: Record<RunStatus, string> = {
  running: "läuft",
  waiting: "wartet auf dich",
  "loop-ended": "Schleife fertig – Prüfungen/PR",
  ended: "beendet",
};

const ERROR_LINE = /\b(error|errors|fail(?:ed|ure|s)?|fehler|fehlgeschlagen|exception|panic|traceback|denied|fatal)\b|✗|✖|ERR!|exit code [1-9]|\b137\b/i;
const MAX_TEXT = 2_000_000;

let root: HTMLElement | null = null;
let tree: HTMLElement;
let pane: HTMLElement;
let paneHead: HTMLElement;
let tabs: HTMLElement;
let pre: HTMLElement;
let info: HTMLElement;
let errorsOnly = false;
let logParts: HTMLElement[];
let grillPane: HTMLElement;
let grillPaneSig = "";
let search = "";
const machineEls = new Map<string, { el: HTMLElement; sig: string }>();
const forms = new Map<string, HTMLElement>();

interface LogState {
  server: string;
  path: string;
  text: string;
  offset: number;
  loading: boolean;
  error: string | null;
}
let log: LogState | null = null;
let shownSig = "";
let lastSel = "null";
/** what pre shows as plain text, so following can append instead of rewriting */
let plain: { path: string; len: number } | null = null;

export function runsView(): HTMLElement {
  if (root) return root;
  tree = h("div", { class: "tree" });
  tabs = h("div", { class: "log-tabs" });
  paneHead = h("div", { class: "log-title" });
  const onlyErrors = h("button", { class: "btn small toggle", "aria-pressed": "false" }, "Nur Fehler");
  onlyErrors.addEventListener("click", () => {
    errorsOnly = !errorsOnly;
    onlyErrors.setAttribute("aria-pressed", String(errorsOnly));
    onlyErrors.classList.toggle("on", errorsOnly);
    renderLog(true);
  });
  const find = h("input", { type: "search", class: "log-search", placeholder: "Suchen …", "aria-label": "Im Log suchen" });
  find.addEventListener("input", () => {
    search = find.value;
    renderLog(true);
  });
  const copy = h("button", { class: "btn small" }, "Kopieren");
  copy.addEventListener("click", async () => {
    const ok = await copyText(visibleLines().join("\n"));
    toast(ok ? "Log kopiert" : "Kopieren nicht möglich", ok ? "info" : "error");
  });
  const back = h("button", { class: "btn small back", onclick: () => root?.classList.remove("log-open") }, "‹ Läufe");
  pre = h("pre", { class: "log" });
  info = h("div", { class: "log-info muted small" });
  const logHead = h("div", { class: "log-head" }, back, paneHead, tabs);
  const logTools = h("div", { class: "log-tools" }, onlyErrors, find, copy, info);
  grillPane = h("div", { class: "grill-log", hidden: true });
  logParts = [logHead, logTools, pre];
  pane = h("section", { class: "logpane" }, logHead, logTools, pre, grillPane);
  root = h("div", { class: "runs" }, tree, pane);
  return root;
}

// ---- tree

function machineSig(s: Server): string {
  return JSON.stringify([s, state.statuses.get(s.id), state.statusErrors.get(s.id), state.selection, state.grillSel, state.board?.etag, state.slug, projectOn(s.id)?.slug, state.startFor === s.id, derive().lanes.find((l) => l.server.id === s.id)?.order.length]);
}

function machineEl(s: Server): HTMLElement {
  const sig = machineSig(s);
  const hit = machineEls.get(s.id);
  if (hit?.sig === sig) return hit.el;
  const status = state.statuses.get(s.id);
  const err = state.statusErrors.get(s.id);
  const runs = [...(status?.runs ?? [])].sort(
    (a, b) => Number(b.status !== "ended") - Number(a.status !== "ended") || Date.parse(b.startedAt ?? "0") - Date.parse(a.startedAt ?? "0"),
  );
  const project = projectOn(s.id);
  const liveRuns = runs.filter((r) => r.status !== "ended");
  const lockRun = status?.lock ? runs.find((r) => r.source === "hollr" && r.status !== "ended") : undefined;
  const el = h(
    "section",
    { class: `machine${s.online ? "" : " offline"}` },
    h(
      "div",
      { class: "machine-head" },
      h("span", { class: `dot ${!s.online ? "off" : liveRuns.length ? `st-${liveRuns[0]?.status}` : "idle"}` }),
      h("b", {}, s.label),
      status && status.machine.host !== s.label ? h("span", { class: "muted small" }, status.machine.host) : null,
      h("span", { class: "grow" }),
      !s.online ? h("span", { class: "muted small" }, "offline") : !status && !err ? h("span", { class: "muted small" }, "lädt …") : null,
    ),
    err ? h("p", { class: "error small" }, err) : null,
    status?.grills?.length ? grillsGroup(s.id, status.grills) : null,
    status?.lock && !lockRun
      ? h("div", { class: "lock-row small" }, `Sperre: ${String(status.lock.project ?? "?")} `, releaseButton(s.id))
      : null,
    !status?.lock && project && s.online && status ? startForm(s, project) : null,
    ...runs.map((r) => runEl(s, r, r === lockRun)),
    status && !runs.length ? h("p", { class: "muted small" }, "Keine Läufe in den letzten 24 Std.") : null,
  );
  machineEls.set(s.id, { el, sig });
  return el;
}

function releaseButton(server: string): HTMLElement {
  // two steps instead of confirm(): embedded webviews answer confirm() with "no" without showing it
  const btn = h("button", { class: "btn small", title: "Gibt die Sperre frei, beendet die Sitzung nicht." }, "Lauf freigeben");
  btn.addEventListener("click", async () => {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Wirklich? Sitzung läuft weiter";
      setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = "Lauf freigeben";
      }, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await sc.release(server);
      toast("Sperre freigegeben", "info");
    } catch (err) {
      toast(errorText(err));
    }
    await hooks.reloadStatus();
  });
  return btn;
}

function select(server: string, run: string, n: number | null, path: string | null): void {
  state.selection = { server, run, n, path };
  state.grillSel = null;
  root?.classList.add("log-open");
  renderRuns();
}

function runEl(s: Server, r: Run, holdsLock: boolean): HTMLElement {
  const sel = state.selection;
  const selRun = sel?.server === s.id && sel.run === r.id;
  const agent = [r.config.agentLabel || r.config.agent, r.config.model && r.config.model !== r.config.agentLabel ? r.config.model : null].filter(Boolean).join(" · ");
  return h(
    "div",
    { class: `run-node${r.status === "ended" ? " ended" : ""}` },
    h(
      "button",
      { class: `run-title${selRun && sel?.n === null ? " selected" : ""}`, onclick: () => select(s.id, r.id, null, null) },
      h("b", {}, r.project),
      h("span", { class: `pill ${r.status}` }, STATUS_TEXT[r.status]),
      h("span", { class: "grow" }),
      h("span", { class: "pct" }, `${r.progress.percent} %`),
    ),
    h("div", { class: "branch-full mono small" }, h("span", { class: "dot", style: `background:${branchColour(r.branch)}` }), r.branch || "–"),
    h("div", { class: "segbar" }, ...segments(r.issues).map((p) => h("span", { class: `seg ${p}` }))),
    h(
      "div",
      { class: "run-meta muted small" },
      [
        agent,
        r.config.parallel ? `×${r.config.parallel}` : "",
        r.startedAt ? `seit ${fmtDate(r.startedAt)} (${since(r.startedAt)})` : "",
        r.source === "manual" ? "von Hand gestartet" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      r.pr && r.slug
        ? h("span", {}, " · ", h("button", { class: "link", onclick: () => openExternal(`https://github.com/${r.slug}/pull/${r.pr}`) }, `PR #${r.pr}`))
        : null,
    ),
    r.status === "waiting" ? h("p", { class: "warn small" }, "Der Lauf wartet auf eine Antwort – Sitzung öffnen.") : null,
    r.status !== "ended" && (r.pane || holdsLock)
      ? h(
          "div",
          { class: "btn-row" },
          r.pane && hasHost() ? h("button", { class: "btn small", onclick: () => r.pane && openSession(s.id, r.pane) }, "Sitzung öffnen") : null,
          holdsLock ? releaseButton(s.id) : null,
        )
      : null,
    h(
      "ul",
      { class: "tickets" },
      ...r.issues.map((i) =>
        h(
          "li",
          {},
          h(
            "button",
            { class: `ticket-row${selRun && sel?.n === i.n ? " selected" : ""}`, onclick: () => select(s.id, r.id, i.n, null) },
            h("span", { class: "num" }, `#${i.n}`),
            h("span", { class: "t" }, i.title ?? derive().issues.get(i.n)?.title ?? ""),
            h("span", { class: `phase ${i.phase}` }, `${i.logs.some((l) => l.active) ? "● " : ""}${PHASE_TEXT[i.phase]}`),
          ),
          i.reason && i.phase !== "merged" ? h("div", { class: "error small reason" }, i.reason) : null,
        ),
      ),
    ),
  );
}

// ---- start form (one per machine and project; kept across renders so typed values survive polls)

function startForm(s: Server, p: Project): HTMLElement {
  const key = `${s.id}|${p.slug}`;
  let form = forms.get(key);
  const queued = derive().lanes.find((l) => l.server.id === s.id)?.order.length ?? 0;
  const blocked =
    p.engine !== "sandcastle"
      ? `Projekt ${p.name} nutzt den Motor ${p.engine}, nicht Sandcastle.`
      : !p.queueSupported
        ? "Die Schleife dieses Projekts kennt die Warteschlange noch nicht (lul-workr-setup → Sandcastle nachziehen)."
        : !queued
          ? "Die Warteschlange auf diesem Rechner ist leer – im Board Karten in seine Sandcastle-Spalte ziehen."
          : "";
  if (!form) {
    const last = prefGet<{ agent: string; parallel: number; screencast: boolean; deploy: boolean }>(`cfg.${p.slug}`);
    const agents = p.agents.length ? p.agents : [{ key: p.defaults.agent, label: p.defaults.agent, harness: "", model: "" }];
    const agent = h("select", { name: "agent" }, ...agents.map((a) => h("option", { value: a.key }, a.model && a.model !== a.label ? `${a.label} (${a.model})` : a.label)));
    agent.value = agents.some((a) => a.key === last?.agent) ? (last?.agent ?? "") : p.defaults.agent;
    const parallel = h("input", { type: "number", min: 1, max: 8, value: last?.parallel ?? p.defaults.parallel, name: "parallel" });
    const warn = h("p", { class: "warn small" }, "Ab 4 parallel: erhöhtes Risiko, dass der Kernel Prozesse abschießt (137).");
    const screencast = h("input", { type: "checkbox", checked: last?.screencast ?? false });
    const deploy = h("input", { type: "checkbox", checked: last?.deploy ?? true });
    const reason = h("p", { class: "reason small" });
    const error = h("p", { class: "error small" });
    const submit = h("button", { class: "btn primary", type: "submit" }, "Lauf starten");
    const sync = () => {
      warn.hidden = Number(parallel.value) < 4;
    };
    parallel.addEventListener("input", sync);
    sync();
    form = h(
      "form",
      {
        class: "start",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (form?.dataset.blocked) return;
          const config = { agent: agent.value, parallel: Math.max(1, Math.round(Number(parallel.value) || 1)), screencast: screencast.checked, deploy: deploy.checked };
          submit.disabled = true;
          error.textContent = "";
          try {
            const res = await sc.start(s.id, p.slug, config);
            prefSet(`cfg.${p.slug}`, config);
            toast(`Lauf auf ${s.label} gestartet`, "info");
            if (res.pane && hasHost()) openSession(s.id, res.pane);
            state.startFor = null;
            await hooks.reloadStatus();
          } catch (err) {
            error.textContent = errorText(err);
          } finally {
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "start-title" }, `Neuer Lauf: ${p.name}`),
      h("div", { class: "row" }, h("label", {}, "Agent", agent), h("label", {}, "Parallel", parallel)),
      warn,
      h("label", { class: "check" }, deploy, " Testserver auf workr (Standard)"),
      h("label", { class: "check" }, screencast, " Screencast"),
      h("div", { class: "btn-row" }, submit),
      reason,
      error,
    );
    forms.set(key, form);
  }
  form.dataset.blocked = blocked;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (submit) submit.disabled = !!blocked;
  const reason = form.querySelector(".reason");
  if (reason) reason.textContent = blocked;
  form.classList.toggle("highlight", state.startFor === s.id);
  return form;
}

// ---- log pane

interface Resolved {
  server: string;
  run: Run;
  n: number | null;
  files: LogFile[];
  file: LogFile | null;
}

function resolve(): Resolved | null {
  const sel = state.selection;
  if (!sel) return null;
  const run = state.statuses.get(sel.server)?.runs.find((r) => r.id === sel.run);
  if (!run) return null;
  const files = sel.n === null ? run.logs : (run.issues.find((i) => i.n === sel.n)?.logs ?? []);
  const order = ["implementer", "reviewer", "planner", "merger", "other"];
  files.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.mtime - b.mtime);
  const file = files.find((f) => f.path === sel.path) ?? files.find((f) => f.active) ?? files[files.length - 1] ?? null;
  return { server: sel.server, run, n: sel.n, files, file };
}

function visibleLines(): string[] {
  const lines = (log?.text ?? "").split("\n");
  const q = search.trim().toLocaleLowerCase("de");
  return lines.filter((l) => (!errorsOnly || ERROR_LINE.test(l)) && (!q || l.toLocaleLowerCase("de").includes(q)));
}

function renderLog(force = false): void {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const sig = `${log?.path}|${log?.text.length}|${log?.error}|${log?.loading}|${errorsOnly}|${search}`;
  if (!force && sig === shownSig) return;
  shownSig = sig;
  if (!log) {
    fill(pre, h("span", { class: "muted" }, state.selection ? "Für diese Auswahl gibt es noch kein Log." : "Links einen Lauf oder ein Ticket wählen."));
    info.textContent = "";
    return;
  }
  if (log.error) {
    fill(pre, h("span", { class: "error" }, log.error));
    return;
  }
  if (!log.text && log.loading) {
    fill(pre, h("span", { class: "muted" }, "Lädt …"));
    return;
  }
  const lines = visibleLines();
  const q = search.trim();
  if (!q && !errorsOnly) {
    // following: only the new tail goes into the DOM, not the whole (up to 2 MB) text again
    if (plain?.path === log.path && log.text.length > plain.len && pre.lastChild?.nodeType === Node.TEXT_NODE && !force)
      pre.append(log.text.slice(plain.len));
    else pre.textContent = log.text;
    plain = { path: log.path, len: log.text.length };
  } else if (!q) pre.textContent = lines.join("\n");
  else {
    // highlight hits; the newest 3000 matching lines are plenty
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const frag = document.createDocumentFragment();
    for (const line of lines.slice(-3000)) {
      let last = 0;
      for (const m of line.matchAll(re)) {
        frag.append(line.slice(last, m.index), h("mark", {}, m[0]));
        last = (m.index ?? 0) + m[0].length;
      }
      frag.append(`${line.slice(last)}\n`);
    }
    pre.replaceChildren(frag);
  }
  if (q || errorsOnly) plain = null;
  const live = resolve()?.file?.active;
  info.textContent = `${q || errorsOnly ? `${lines.length} Zeilen` : ""}${live ? "  ● folgt live" : ""}`;
  if (atBottom || force) pre.scrollTop = pre.scrollHeight;
}

async function fetchLog(follow: boolean): Promise<void> {
  const cur = log;
  if (!cur || cur.loading) return;
  cur.loading = true;
  try {
    const chunk = await sc.log(cur.server, cur.path, follow ? cur.offset : undefined);
    if (log !== cur) return;
    // truncated or rotated: start over from the tail
    if (follow && chunk.size < cur.offset) {
      cur.offset = 0;
      cur.text = "";
      cur.loading = false;
      return fetchLog(false);
    }
    cur.text = follow ? cur.text + chunk.text : chunk.text;
    if (cur.text.length > MAX_TEXT) {
      cur.text = cur.text.slice(cur.text.indexOf("\n", cur.text.length - MAX_TEXT) + 1);
      plain = null;
    }
    cur.offset = chunk.offset;
    cur.error = null;
  } catch (err) {
    if (log === cur) cur.error = errorText(err);
  } finally {
    cur.loading = false;
  }
  if (log === cur) renderLog();
}

/** Called every 1.5 s by app.ts while the Läufe view is visible: follow the active log. */
export function followLog(): void {
  const r = resolve();
  if (!log || !r?.file || r.file.path !== log.path || log.error) return;
  if (r.file.active || r.file.size > log.offset) fetchLog(true);
}

// ---- grills

function grillsGroup(server: string, grills: Grill[]): HTMLElement {
  const time = (g: Grill) => Date.parse(g.updatedAt ?? g.startedAt ?? "") || 0;
  const sorted = [...grills].sort((a, b) => Number(isLiveGrill(b)) - Number(isLiveGrill(a)) || time(b) - time(a));
  return h(
    "div",
    { class: "grills" },
    h("div", { class: "grills-head small" }, h("span", { "aria-hidden": "true" }, "🔥"), " Grills"),
    ...sorted.map((g) => {
      const sel = state.grillSel?.server === server && state.grillSel.id === g.id;
      const title = g.slug === state.slug && g.n !== null ? state.board?.issues.find((i) => i.number === g.n)?.title : undefined;
      return h(
        "button",
        {
          class: `grill-row${sel ? " selected" : ""}${isLiveGrill(g) ? "" : " ended"}`,
          onclick: () => {
            state.grillSel = { server, id: g.id };
            state.selection = null;
            root?.classList.add("log-open");
            renderRuns();
          },
        },
        h(
          "span",
          { class: "grill-row-title" },
          [g.key, g.n !== null ? `#${g.n}` : null].filter(Boolean).join(" · "),
          h("span", { class: "t" }, title ?? g.project ?? ""),
        ),
        h("span", { class: "grill-row-meta small" }, h("span", { class: "muted" }, modeText(g.mode)), grillPill(g), h("span", { class: "muted" }, stepText(g))),
        grillBar(g),
      );
    }),
  );
}

/** Right side: the selected grill instead of the log (same pane, so phones open it full screen the same way). */
function renderGrillPane(): boolean {
  const sel = state.grillSel;
  const showGrill = !!sel;
  grillPane.hidden = !showGrill;
  for (const el of logParts) el.hidden = showGrill;
  if (!sel) return false;
  const g = state.statuses.get(sel.server)?.grills?.find((x) => x.id === sel.id);
  const sig = JSON.stringify([sel, g, state.board?.etag, hasHost()]);
  if (sig !== grillPaneSig) {
    grillPaneSig = sig;
    grillLog(grillPane, sel.server, g, () => root?.classList.remove("log-open"));
  }
  return true;
}

function renderPane(): void {
  if (renderGrillPane()) return;
  const r = resolve();
  const sel = state.selection;
  if (!r) {
    fill(paneHead, sel ? "Lauf nicht mehr da" : "Log");
    fill(tabs);
    if (log) log = null;
    renderLog();
    return;
  }
  const title = r.n === null ? `${r.run.project} · Lauf` : `#${r.n} ${r.run.issues.find((i) => i.n === r.n)?.title ?? derive().issues.get(r.n)?.title ?? ""}`;
  fill(paneHead, h("b", {}, title), h("span", { class: "muted small" }, ` ${serverLabel(r.server)} · ${r.run.branch}`));
  reconcile(
    tabs,
    r.files.map((f) =>
      h(
        "button",
        { class: `tab${f.path === r.file?.path ? " active" : ""}`, onclick: () => sel && select(sel.server, sel.run, sel.n, f.path) },
        `${f.role === "other" ? f.name : f.role}${f.active ? " ●" : ""}`,
      ),
    ),
  );
  if (!r.file) {
    log = null;
    renderLog();
    return;
  }
  if (log?.path !== r.file.path || log.server !== r.server) {
    log = { server: r.server, path: r.file.path, text: "", offset: 0, loading: false, error: null };
    renderLog();
    fetchLog(false).then(() => renderLog(true));
  }
}

export function renderRuns(): void {
  if (!root) return;
  const servers = [...state.servers].sort((a, b) => Number(b.self) - Number(a.self) || a.label.localeCompare(b.label, "de"));
  reconcile(tree, servers.length ? servers.map(machineEl) : [h("p", { class: "muted pad" }, "Rechner werden gesucht …")]);
  if (state.startFor) {
    const f = forms.get(`${state.startFor}|${state.slug}`);
    if (f) {
      f.scrollIntoView({ block: "nearest" });
      f.querySelector("select")?.focus();
    }
    state.startFor = null;
  }
  // a new selection (e.g. a building card tapped on the board) opens the log full screen on phones
  const selKey = JSON.stringify(state.selection);
  if (state.selection && selKey !== lastSel) root.classList.add("log-open");
  lastSel = selKey;
  renderPane();
}
