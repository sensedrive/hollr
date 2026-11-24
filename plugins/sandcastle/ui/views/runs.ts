/**
 * Läufe (design v23). Left per machine one status block („Läuft seit … · project · Schritt: …“, „Wartet auf dich …“
 * or „Frei – Lauf starten“, which opens „Neuer Lauf“), the live run's tickets with phase pills and „Frühere Läufe“
 * folded; the grills of all machines in their own folded section. Right the selected run: the waiting banner, title,
 * „Was passiert gerade“ – a plain sentence and the timeline Start → … → Bericht with the current step highlighted –
 * and its log folded below (implementer · reviewer of a ticket, planner · merger of the run), following the tail live.
 * Narrow: the list alone; tapping opens the detail full screen. Machines, detail head and log are cached and rebuilt
 * only when what they show changed, so the 4 s polls never reset an open fold or a scrolled log.
 */
import { hasHost, openExternal, openSession, sc } from "../api";
import { derive, openBlockers } from "../derive";
import { copyText, fill, fmtDate, h, icon, reconcile } from "../dom";
import { isLiveGrill, modeText, stepText as grillStepText } from "../grill";
import { ICON } from "../icons";
import { since } from "../model";
import { errorText, hooks, projectOn, serverLabel, state, toast } from "../state";
import { clearText, currentStation, finishedCount, loopPosition, PHASE_PILL, type Station, stepText, timeline } from "../timeline";
import type { Grill, LogFile, Run, RunStatus, Server } from "../types";
import { grillBar, grillLog, grillPill } from "./grilling";
import { newRunModal } from "./newrun";

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
let machinesEl: HTMLElement;
let grillsEl: HTMLElement;
let grillsSig = "";
let pane: HTMLElement;
let grillPane: HTMLElement;
let grillPaneSig = "";
let runPane: HTMLElement;
let runTop: HTMLElement;
let runTopSig = "";
let emptyPane: HTMLElement;
let emptySig = "";
let logToggle: HTMLButtonElement;
let logPanel: HTMLElement;
let paneHead: HTMLElement;
let tabs: HTMLElement;
let pre: HTMLElement;
let info: HTMLElement;
let errorsOnly = false;
let search = "";
/** the log fold below the timeline: open for a selected ticket, folded for a run */
let logOpen = false;
let grillsOpen = false;
const machineEls = new Map<string, { el: HTMLElement; sig: string }>();
/** machines whose „Frühere Läufe“ are unfolded / whose „Lauf freigeben“ asks for confirmation */
const earlierOpen = new Set<string>();
const confirming = new Set<string>();

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
  machinesEl = h("ul", { class: "rt-machines", "aria-label": "Maschinen und Läufe" });
  grillsEl = h("div", { class: "rt-grills-host" });
  tree = h("nav", { class: "tree", "aria-label": "Läufe je Maschine" }, machinesEl, grillsEl);
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
  pre = h("pre", { class: "log" });
  info = h("div", { class: "log-info muted small" });
  logToggle = h("button", { class: "run-log-toggle", "aria-expanded": "false", "aria-controls": "run-log-panel" });
  logToggle.addEventListener("click", () => {
    logOpen = !logOpen;
    syncLogFold();
    if (logOpen) renderLog(true);
  });
  logPanel = h(
    "div",
    { class: "run-log-panel", id: "run-log-panel", hidden: true },
    h("div", { class: "log-head" }, paneHead, tabs),
    h("div", { class: "log-tools" }, onlyErrors, find, copy, info),
    pre,
  );
  runTop = h("div", { class: "run-top" });
  const back = () => root?.classList.remove("log-open");
  runPane = h(
    "div",
    { class: "run-detail", hidden: true },
    h("button", { class: "btn small back", onclick: back }, "‹ Läufe"),
    runTop,
    h("section", { class: "run-log" }, h("h3", { class: "run-log-head" }, logToggle), logPanel),
  );
  emptyPane = h("div", { class: "runs-empty", hidden: true });
  grillPane = h("div", { class: "grill-log", hidden: true });
  pane = h("section", { class: "logpane" }, runPane, grillPane, emptyPane);
  root = h("div", { class: "runs" }, tree, pane);
  return root;
}

// ---- small pieces

/** „heute, 14:02“ for today, else date and time. */
function startedText(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? `heute, ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}` : fmtDate(iso);
}

const agentText = (r: Run) => r.config.agentLabel || r.config.agent || "";

/** Open blockers of an issue (board data), for „#614 wartet auf #598“. */
function blockersOf(): (n: number) => number[] {
  const d = derive();
  return (n) => {
    const issue = d.issues.get(n);
    return issue ? openBlockers(d, issue) : [];
  };
}

const titleOf = (n: number, r: Run) => r.issues.find((i) => i.n === n)?.title ?? derive().issues.get(n)?.title ?? "";

function select(server: string, run: string, n: number | null, path: string | null): void {
  state.selection = { server, run, n, path };
  state.grillSel = null;
  root?.classList.add("log-open");
  renderRuns();
}

function sessionButton(server: string, r: Run, primary: boolean): HTMLElement | null {
  if (!r.pane || !hasHost()) return null;
  const pane = r.pane;
  return h("button", { class: `btn${primary ? " primary" : ""}`, onclick: () => openSession(server, pane) }, "Sitzung öffnen");
}

// ---- left: machines

function machineSig(s: Server): string {
  return JSON.stringify([
    s,
    state.statuses.get(s.id),
    state.statusErrors.get(s.id),
    state.selection,
    state.board?.etag,
    state.slug,
    projectOn(s.id)?.slug,
    earlierOpen.has(s.id),
    confirming.has(s.id),
    hasHost(),
    // „Läuft seit 38 Min.“
    Math.floor(Date.now() / 60_000),
  ]);
}

function machineEl(s: Server): HTMLElement {
  const sig = machineSig(s);
  const hit = machineEls.get(s.id);
  if (hit?.sig === sig) return hit.el;
  const status = state.statuses.get(s.id);
  const err = state.statusErrors.get(s.id);
  const runs = [...(status?.runs ?? [])].sort((a, b) => Date.parse(b.startedAt ?? "0") - Date.parse(a.startedAt ?? "0"));
  const live = runs.filter((r) => r.status !== "ended");
  const earlier = runs.filter((r) => r.status === "ended");
  const holdsLock = (r: Run) => !!status?.lock && r.source === "hollr";
  const el = h(
    "li",
    { class: `rt-machine${s.online ? "" : " offline"}` },
    h(
      "h2",
      { class: "rt-name" },
      icon(ICON.server, "rt-icon"),
      h("span", {}, s.label),
      status && status.machine.host !== s.label ? h("span", { class: "muted small" }, status.machine.host) : null,
      !s.online ? h("span", { class: "muted small" }, "offline") : !status && !err ? h("span", { class: "muted small" }, "lädt …") : null,
    ),
    err ? h("p", { class: "error small" }, err) : null,
    ...live.flatMap((r) => [statusBlock(s, r, holdsLock(r)), ticketList(s, r)]),
    !live.length && status?.lock
      ? h("div", { class: "rt-block", "data-status": "waiting" }, h("p", { class: "rt-free" }, `Sperre: ${String(status.lock.project ?? "?")} – kein laufender Lauf`), releaseControl(s.id))
      : null,
    !live.length && !status?.lock && s.online && status ? freeBlock(s) : null,
    earlier.length ? earlierEl(s, earlier) : null,
  );
  machineEls.set(s.id, { el, sig });
  return el;
}

function statusBlock(s: Server, r: Run, holdsLock: boolean): HTMLElement {
  const sel = state.selection;
  const stations = timeline(r);
  const head = r.status === "waiting" ? "Wartet auf dich" : "Läuft";
  return h(
    "div",
    { class: "rt-block", "data-status": r.status === "waiting" ? "waiting" : "running" },
    h(
      "button",
      { class: "rt-run-title", "aria-pressed": String(sel?.server === s.id && sel.run === r.id && sel.n === null), onclick: () => select(s.id, r.id, null, null) },
      h("span", { class: "rt-dot", "aria-hidden": "true" }),
      h("span", { class: "rt-summary" }, `${head} seit ${since(r.startedAt) || "?"} · ${r.project} · Schritt: ${stepText(r, stations)}`),
    ),
    r.issues.length
      ? h(
          "div",
          { class: "rt-progress" },
          h("span", { class: "segbar" }, ...r.issues.map((i) => h("span", { class: `seg ${i.phase}` }))),
          h("span", { class: "rt-stats" }, `${finishedCount(r)}/${r.issues.length} Tickets`),
        )
      : null,
    r.source === "manual" ? h("span", { class: "muted small" }, "von Hand gestartet") : null,
    holdsLock ? releaseControl(s.id) : null,
  );
}

/** „Lauf freigeben“ with an inline confirmation (embedded webviews answer confirm() with „no“ unseen). */
function releaseControl(server: string): HTMLElement {
  const redraw = () => {
    machineEls.delete(server);
    renderRuns();
  };
  if (!confirming.has(server))
    return h(
      "button",
      {
        class: "rt-link-button",
        onclick: () => {
          confirming.add(server);
          redraw();
        },
      },
      "Lauf freigeben",
    );
  const cancel = () => {
    confirming.delete(server);
    redraw();
  };
  return h(
    "div",
    { class: "rt-confirm", role: "group", "aria-label": "Lauf freigeben bestätigen", onkeydown: (e: Event) => (e as KeyboardEvent).key === "Escape" && cancel() },
    h("p", { class: "rt-confirm-text" }, "Gibt nur die Sperre frei; die Sitzung läuft weiter."),
    h(
      "button",
      {
        class: "btn",
        onclick: async () => {
          confirming.delete(server);
          try {
            await sc.release(server);
            toast("Sperre freigegeben", "info");
          } catch (err) {
            toast(errorText(err));
          }
          await hooks.reloadStatus();
        },
      },
      "Freigeben",
    ),
    h("button", { class: "btn ghost", onclick: cancel }, "Abbrechen"),
  );
}

function ticketList(s: Server, r: Run): HTMLElement {
  const sel = state.selection;
  const blockers = blockersOf();
  return h(
    "ul",
    { class: "rt-tickets", "aria-label": `Tickets von ${r.project}` },
    ...r.issues.map((i) => {
      const waitsFor = i.phase === "queued" ? blockers(i.n) : [];
      return h(
        "li",
        {},
        h(
          "button",
          { class: "rt-ticket", "aria-pressed": String(sel?.server === s.id && sel.run === r.id && sel.n === i.n), onclick: () => select(s.id, r.id, i.n, null) },
          h("span", { class: "rt-nr" }, `#${i.n}`),
          h("span", { class: "rt-title" }, titleOf(i.n, r)),
          h("span", { class: "rt-phase", "data-phase": i.phase }, waitsFor.length ? `wartet auf #${waitsFor[0]}` : PHASE_PILL[i.phase]),
        ),
        i.reason && i.phase !== "merged" ? h("p", { class: "error small rt-reason" }, i.reason) : null,
      );
    }),
  );
}

function freeBlock(s: Server): HTMLElement {
  return h(
    "div",
    { class: "rt-block", "data-status": "free" },
    h("p", { class: "rt-free" }, h("span", { class: "rt-dot", "aria-hidden": "true" }), "Frei – hier läuft gerade nichts"),
    projectOn(s.id)
      ? h("button", { class: "rt-action", onclick: () => newRunModal(s.id) }, icon(ICON.play, "rt-icon"), "Lauf starten")
      : h("p", { class: "muted small" }, "Dieses Projekt ist hier nicht ausgecheckt."),
  );
}

function earlierEl(s: Server, runs: Run[]): HTMLElement {
  const open = earlierOpen.has(s.id);
  const sel = state.selection;
  const id = `rt-earlier-${s.id}`;
  return h(
    "div",
    { class: "rt-earlier" },
    h(
      "button",
      {
        class: "rt-toggle",
        "aria-expanded": String(open),
        "aria-controls": id,
        onclick: () => {
          if (open) earlierOpen.delete(s.id);
          else earlierOpen.add(s.id);
          renderRuns();
        },
      },
      icon(open ? ICON.chevDown : ICON.chevRight, "rt-icon"),
      `Frühere Läufe (${runs.length})`,
    ),
    open
      ? h(
          "ul",
          { class: "rt-tickets", id },
          ...runs.map((r) =>
            h(
              "li",
              {},
              h(
                "button",
                { class: "rt-ticket", "aria-pressed": String(sel?.server === s.id && sel.run === r.id), onclick: () => select(s.id, r.id, null, null) },
                h("span", { class: "rt-title" }, `${r.project} · ${r.branch || "–"}`),
                h("span", { class: "rt-phase", "data-phase": "merged" }, `beendet vor ${since(r.endedAt ?? r.startedAt) || "?"}`),
              ),
            ),
          ),
        )
      : null,
  );
}

// ---- left: grills of all machines, folded

function renderGrills(): void {
  const all = state.servers.flatMap((s) => (state.statuses.get(s.id)?.grills ?? []).map((g) => ({ server: s.id, g })));
  if (state.grillSel) grillsOpen = true;
  const sig = JSON.stringify([all, grillsOpen, state.grillSel, state.board?.etag, state.slug]);
  if (sig === grillsSig) return;
  grillsSig = sig;
  if (!all.length) {
    fill(grillsEl);
    return;
  }
  const time = (g: Grill) => Date.parse(g.updatedAt ?? g.startedAt ?? "") || 0;
  const sorted = all.sort((a, b) => Number(isLiveGrill(b.g)) - Number(isLiveGrill(a.g)) || time(b.g) - time(a.g));
  fill(
    grillsEl,
    h(
      "section",
      { class: "rt-grills" },
      h(
        "h2",
        { class: "rt-grills-title" },
        h(
          "button",
          {
            class: "rt-toggle",
            "aria-expanded": String(grillsOpen),
            "aria-controls": "rt-grill-list",
            onclick: () => {
              grillsOpen = !grillsOpen;
              renderGrills();
            },
          },
          icon(grillsOpen ? ICON.chevDown : ICON.chevRight, "rt-icon"),
          icon(ICON.flame, "rt-icon"),
          `Grills (${all.length})`,
        ),
      ),
      grillsOpen
        ? h(
            "ul",
            { class: "rt-tickets", id: "rt-grill-list" },
            ...sorted.map(({ server, g }) => {
              const sel = state.grillSel?.server === server && state.grillSel.id === g.id;
              const title = g.slug === state.slug && g.n !== null ? state.board?.issues.find((i) => i.number === g.n)?.title : undefined;
              return h(
                "li",
                {},
                h(
                  "button",
                  {
                    class: `grill-row${isLiveGrill(g) ? "" : " ended"}`,
                    "aria-pressed": String(sel),
                    onclick: () => {
                      state.grillSel = { server, id: g.id };
                      state.selection = null;
                      root?.classList.add("log-open");
                      renderRuns();
                    },
                  },
                  h("span", { class: "grill-row-title" }, h("span", { class: "rt-nr" }, [g.key, g.n !== null ? `#${g.n}` : null].filter(Boolean).join(" · ")), h("span", { class: "t" }, title ?? g.project ?? "")),
                  h("span", { class: "grill-row-meta small" }, h("span", { class: "muted" }, `${modeText(g.mode)} auf ${serverLabel(server)}`), grillPill(g), h("span", { class: "muted" }, grillStepText(g))),
                  grillBar(g),
                ),
              );
            }),
          )
        : null,
    ),
  );
}

// ---- right: the selected run

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
  const files = [...(sel.n === null ? run.logs : (run.issues.find((i) => i.n === sel.n)?.logs ?? []))];
  const order = ["implementer", "reviewer", "planner", "merger", "other"];
  files.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.mtime - b.mtime);
  const file = files.find((f) => f.path === sel.path) ?? files.find((f) => f.active) ?? files[files.length - 1] ?? null;
  return { server: sel.server, run, n: sel.n, files, file };
}

function timelineEl(r: Run, stations: Station[]): HTMLElement {
  const ended = r.status === "ended";
  const at = currentStation(stations);
  const text = clearText(r, stations, blockersOf());
  const mark = (s: Station, i: number): Node | string =>
    s.state === "done"
      ? icon(ICON.check, "tl-icon")
      : s.state === "waiting"
        ? icon(ICON.hourglass, "tl-icon")
        : s.state === "current"
          ? icon(ICON.loader, "tl-icon")
          : s.state === "failed"
            ? "✗"
            : s.state === "skipped"
              ? "–"
              : String(i + 1);
  const suffix: Record<Station["state"], string> = {
    done: " – erledigt",
    current: " – läuft jetzt",
    waiting: " – wartet auf dich",
    failed: " – fehlgeschlagen",
    skipped: " – übersprungen",
    todo: " – folgt",
    unknown: " – ohne Angabe",
  };
  return h(
    "section",
    { class: "timeline", "data-status": r.status, "aria-labelledby": "tl-title" },
    h("h3", { class: "tl-title", id: "tl-title" }, ended ? "So ist der Lauf verlaufen" : "Was passiert gerade"),
    h("p", { class: "tl-clear" }, r.status === "waiting" ? h("strong", {}, `Wartet auf deine Antwort${at ? `: ${at.label}` : ""}.`) : null, r.status === "waiting" ? " " : null, text),
    !ended && (r.agent?.say || r.agent?.doing)
      ? h(
          "div",
          { class: "tl-agent" },
          h("span", { class: "tl-agent-head" }, `Zuletzt vom Agenten${r.agent.at ? ` · ${since(r.agent.at) === "0 Min." ? "gerade eben" : `vor ${since(r.agent.at)}`}` : ""}`),
          r.agent.say ? h("p", { class: "tl-agent-say" }, r.agent.say.replace(/\*\*|`/g, "")) : null,
          r.agent.doing ? h("span", { class: "tl-agent-doing" }, `Gerade: ${r.agent.doing}`) : null,
        )
      : null,
    h(
      "ol",
      { class: "tl-list" },
      ...stations.map((s, i) =>
        h(
          "li",
          { class: "tl-stage", "data-state": s.state, "aria-current": s.state === "current" || s.state === "waiting" ? "step" : undefined },
          h("span", { class: "tl-marker", "aria-hidden": "true" }, mark(s, i)),
          h(
            "span",
            { class: "tl-body" },
            h("span", { class: "tl-label" }, s.label, h("span", { class: "tl-state" }, suffix[s.state])),
            s.state === "current" || s.state === "waiting"
              ? h("span", { class: "tl-detail" }, s.detail, s.id === "schleife" && loopPosition(r) ? ` · ${loopPosition(r)}` : "")
              : s.state === "failed" && s.reason
                ? h("span", { class: "tl-detail error" }, s.reason)
                : null,
          ),
        ),
      ),
    ),
  );
}

function renderRunTop(r: Resolved): void {
  const sig = JSON.stringify([r.server, r.run, r.n, hasHost(), state.board?.etag, serverLabel(r.server)]);
  if (sig === runTopSig) return;
  runTopSig = sig;
  const run = r.run;
  const stations = timeline(run);
  const at = currentStation(stations);
  const prUrl = run.pr && run.slug ? `https://github.com/${run.slug}/pull/${run.pr}` : null;
  fill(
    runTop,
    run.status === "waiting"
      ? h(
          "div",
          { class: "run-banner", role: "status" },
          icon(ICON.bell, "run-banner-icon"),
          h(
            "div",
            { class: "run-banner-body" },
            h("p", { class: "run-banner-title" }, `Der Lauf wartet auf deine Antwort${at ? `: ${at.label}` : ""}`),
            h("p", { class: "run-banner-text" }, `Der Agent steht still, bis du in der Sitzung auf ${serverLabel(r.server)} antwortest.`),
          ),
          sessionButton(r.server, run, true),
        )
      : null,
    h(
      "header",
      { class: "run-head" },
      h(
        "div",
        { class: "run-head-text" },
        h("h2", { class: "run-title" }, `${run.project} · ${run.branch || "–"}`),
        h(
          "p",
          { class: "run-meta" },
          [agentText(run), run.config.parallel ? `×${run.config.parallel} parallel` : "", `gestartet ${startedText(run.startedAt)}`, run.source === "manual" ? "von Hand gestartet" : ""].filter(Boolean).join(" · "),
          prUrl ? " · " : null,
          prUrl ? h("button", { class: "link run-pr", onclick: () => openExternal(prUrl) }, `PR #${run.pr}`, icon(ICON.external, "rt-icon")) : null,
        ),
      ),
      run.status === "running" || run.status === "loop-ended" ? sessionButton(r.server, run, false) : null,
    ),
    timelineEl(run, stations),
  );
}

function syncLogFold(): void {
  const lines = log?.text ? log.text.split("\n").filter((l, i, a) => l || i < a.length - 1).length : null;
  const none = !resolve()?.file;
  logToggle.setAttribute("aria-expanded", String(logOpen && !none));
  logToggle.disabled = none;
  fill(
    logToggle,
    icon(logOpen && !none ? ICON.chevDown : ICON.chevRight, "rt-icon"),
    none ? "Noch kein Log" : logOpen ? "Log einklappen" : `Log anzeigen${lines !== null ? ` (${lines} Zeilen)` : ""}`,
  );
  logPanel.hidden = !logOpen || none;
}

// ---- log

function visibleLines(): string[] {
  const lines = (log?.text ?? "").split("\n");
  const q = search.trim().toLocaleLowerCase("de");
  return lines.filter((l) => (!errorsOnly || ERROR_LINE.test(l)) && (!q || l.toLocaleLowerCase("de").includes(q)));
}

function renderLog(force = false): void {
  syncLogFold();
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const sig = `${log?.path}|${log?.text.length}|${log?.error}|${log?.loading}|${errorsOnly}|${search}`;
  if (!force && sig === shownSig) return;
  shownSig = sig;
  if (!log) {
    fill(pre, h("span", { class: "muted" }, "Für diese Auswahl gibt es noch kein Log."));
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

function renderLogPart(r: Resolved): void {
  const sel = state.selection;
  const title = r.n === null ? `Log zum Lauf ${r.run.project} · ${r.run.branch || "–"}` : `Log zu #${r.n} ${titleOf(r.n, r.run)}`;
  fill(paneHead, h("b", {}, title));
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
  } else syncLogFold();
}

// ---- right: grill or nothing selected

/** Right side: the selected grill instead of a run (same pane, so phones open it full screen the same way). */
function renderGrillPane(): boolean {
  const sel = state.grillSel;
  grillPane.hidden = !sel;
  if (!sel) return false;
  const g = state.statuses.get(sel.server)?.grills?.find((x) => x.id === sel.id);
  const sig = JSON.stringify([sel, g, state.board?.etag, hasHost()]);
  if (sig !== grillPaneSig) {
    grillPaneSig = sig;
    grillLog(grillPane, sel.server, g, () => root?.classList.remove("log-open"));
  }
  return true;
}

function renderEmpty(): void {
  const anyRun = [...state.statuses.values()].some((s) => s.runs.length);
  const free = state.servers.filter((s) => s.online && projectOn(s.id) && !state.statuses.get(s.id)?.lock && !state.statuses.get(s.id)?.runs.some((r) => r.status !== "ended"));
  const sig = JSON.stringify([anyRun, free.map((s) => [s.id, s.label]), !!state.selection]);
  if (sig === emptySig) return;
  emptySig = sig;
  const first = free[0];
  fill(
    emptyPane,
    icon(ICON.server, "runs-empty-icon"),
    h("h2", {}, anyRun ? (state.selection ? "Lauf nicht mehr da" : "Kein Lauf gewählt") : "Keine Läufe auf keiner Maschine"),
    h(
      "p",
      { class: "muted" },
      anyRun
        ? "Wähle links einen Lauf, um zu sehen, was gerade passiert."
        : `Reihe im Board Tickets in Sandcastle ein und starte danach einen Lauf${free.length ? ` auf ${free.map((s) => s.label).join(", ").replace(/, ([^,]*)$/, " oder $1")}` : ""}.`,
    ),
    anyRun
      ? null
      : h(
          "div",
          { class: "btn-row" },
          first ? h("button", { class: "btn primary", onclick: () => newRunModal(first.id) }, `Lauf auf ${first.label} starten`) : null,
          h("button", { class: "btn", onclick: () => hooks.show("board") }, "Zum Board"),
        ),
  );
}

/** Nothing chosen yet: the first live run (the design opens on it); phones stay on the list. */
function autoSelect(): void {
  if (state.selection || state.grillSel) return;
  for (const s of state.servers) {
    const r = state.statuses.get(s.id)?.runs.find((x) => x.status !== "ended");
    if (!r) continue;
    state.selection = { server: s.id, run: r.id, n: null, path: null };
    lastSel = JSON.stringify(state.selection);
    return;
  }
}

function renderPane(): void {
  const showGrill = renderGrillPane();
  const r = showGrill ? null : resolve();
  runPane.hidden = !r;
  emptyPane.hidden = showGrill || !!r;
  if (!r) {
    if (!showGrill) renderEmpty();
    if (log) log = null;
    return;
  }
  renderRunTop(r);
  renderLogPart(r);
}

export function renderRuns(): void {
  if (!root) return;
  autoSelect();
  // machines with a live run first, then this one, offline ones last
  const liveOn = (s: Server) => !!state.statuses.get(s.id)?.runs.some((r) => r.status !== "ended");
  const servers = [...state.servers].sort(
    (a, b) => Number(b.online) - Number(a.online) || Number(liveOn(b)) - Number(liveOn(a)) || Number(b.self) - Number(a.self) || a.label.localeCompare(b.label, "de"),
  );
  reconcile(machinesEl, servers.length ? servers.map(machineEl) : [h("p", { class: "muted pad" }, "Rechner werden gesucht …")]);
  renderGrills();
  // „Lauf starten“ from a lane of the board: the dialog, no form here any more
  if (state.startFor) {
    const server = state.startFor;
    state.startFor = null;
    newRunModal(server);
  }
  // a new selection (e.g. a building card tapped on the board) opens the detail full screen on phones; a ticket
  // unfolds its log, a run keeps it folded
  const selKey = JSON.stringify(state.selection);
  if (selKey !== lastSel) {
    if (state.selection) root.classList.add("log-open");
    logOpen = state.selection?.n != null;
  }
  lastSel = selKey;
  renderPane();
}
