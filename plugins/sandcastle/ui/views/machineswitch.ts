/**
 * „Maschine wechseln“ (Lauf-Panel, magicfink sandcastle-board v33/v34): a machine's queue moves to the end of another
 * machine's queue and stays empty here; the user starts the run there. A machine without the project is set up
 * first – clone, the untracked local files (after the user confirmed the list), dependencies, a checklist – then
 * its project list is re-read, its lane appears and the queue moves. File contents only pass through this page
 * (source gate → target gate) and are never kept, cached or logged.
 */
import { sc } from "../api";
import { derive } from "../derive";
import { fill, h, icon } from "../dom";
import { ICON } from "../icons";
import {
  checkSummary,
  copyRows,
  nextStep,
  queueMove,
  runningOn,
  SETUP_STEPS,
  type SetupStep,
  type SwitchTarget,
  sizeText,
  stepDone,
  switchTargets,
} from "../machine";
import { errorText, hooks, projectOn, serverLabel, state } from "../state";
import type { CheckItem, SetupCheck, SetupFileInfo, SetupFilePath, SetupJob } from "../types";

type Mode = "pick" | "setup" | "done";
/** what a view puts into the dialog body; null = nothing */
type Part = Node | null;

const KIND_PILL: Record<SwitchTarget["kind"], [tone: string, ico: string, text: string]> = {
  ready: ["green", ICON.check, "hat das Projekt"],
  setup: ["neutral", ICON.loader, "nicht eingerichtet"],
  busy: ["blue", ICON.hammer, "Lauf läuft"],
  offline: ["neutral", ICON.x, "offline"],
};

/** `/Users/martin/…` or `/home/martin/…` → `~/…` (the path on another machine, whose HOME this page doesn't know) */
const homeShort = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

function pill(tone: string, ico: string, text: string): HTMLElement {
  return h("span", { class: "pill", "data-tone": tone }, icon(ico, "pill-ico"), h("span", { class: "pill-text" }, text));
}

function jobLog(job: SetupJob | null, label: string): HTMLElement | null {
  if (!job?.log) return null;
  return h("details", { class: "ms-log", open: job.running || (job.exit ?? 0) !== 0 }, h("summary", {}, label), h("pre", {}, job.log));
}

/** `tickets`: the lane's tickets as the panel counts them; `openPanel`: shows another machine's run panel. */
export function machineSwitchModal(source: string, opts: { tickets: number; openPanel: (server: string) => void }): void {
  const slug = state.slug;
  const project = derive().project;
  const projectName = project?.name ?? slug;
  const defaultBranch = project?.defaultBranch ?? "main";
  let mode: Mode = "pick";
  let target: string | null = null;
  let check: SetupCheck | null = null;
  let sourceFiles: SetupFileInfo[] = [];
  let targetFiles: SetupFileInfo[] = [];
  let step: SetupStep | "move" = "clone";
  let filesDone = false;
  let installSkipped = false;
  let busy = false;
  /** the step an error belongs to and the action „Erneut versuchen“ repeats */
  let failure: { step: Mode | SetupStep | "move"; text: string; retry: () => void } | null = null;
  let moved = 0;
  const picked = new Set<SetupFilePath>();
  const overwrite = new Set<SetupFilePath>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const close = () => {
    closed = true;
    clearTimeout(timer);
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) close();
  };
  const overlay = h("div", { class: "overlay sheet ms-overlay", onclick: (e: Event) => e.target === overlay && !busy && close() });

  const label = (id: string | null) => (id ? serverLabel(id) : "");

  /** Runs one action: busy while it runs, its error inline at `at`, repeatable. */
  async function act(at: Mode | SetupStep | "move", work: () => Promise<void>): Promise<void> {
    busy = true;
    failure = null;
    paint();
    try {
      await work();
    } catch (err) {
      failure = { step: at, text: errorText(err), retry: () => act(at, work) };
    } finally {
      busy = false;
      if (!closed) paint();
    }
  }

  function errorEl(at: Mode | SetupStep | "move"): HTMLElement | null {
    if (!failure || failure.step !== at) return null;
    const f = failure;
    return h(
      "div",
      { class: "ms-error", role: "alert" },
      h("p", { class: "ms-error-text" }, icon(ICON.alert, "ms-error-ico"), h("span", {}, f.text)),
      h("button", { class: "btn", type: "button", disabled: busy, onclick: () => f.retry() }, "Erneut versuchen"),
    );
  }

  // ---- the queue move (both paths end here)

  async function moveQueue(to: string): Promise<void> {
    await hooks.reloadStatus();
    const busyHere = runningOn(state.statuses.get(source));
    const busyThere = runningOn(state.statuses.get(to));
    if (busyHere) throw new Error(`Auf ${label(source)} läuft gerade ein Lauf – erst danach umziehen.`);
    if (busyThere) throw new Error(`Auf ${label(to)} läuft gerade ein Lauf – erst danach umziehen.`);
    const d = derive();
    const moving = d.lanes.find((l) => l.server.id === source)?.order ?? [];
    if (!moving.length) throw new Error("Die Warteschlange ist leer – es gibt nichts umzuziehen.");
    const targetLane = d.lanes.find((l) => l.server.id === to)?.order ?? (await sc.queue(to, slug)).order;
    const m = queueMove(moving, state.queues.get(source), targetLane);
    // the target first: a failure in between leaves the tickets on both, never on none
    const there = await sc.queueSet(to, slug, m.target);
    if (slug === state.slug) state.queues.set(to, there);
    const here = await sc.queueSet(source, slug, m.source);
    if (slug === state.slug) state.queues.set(source, here);
    moved = opts.tickets;
    target = to;
    mode = "done";
    hooks.render();
  }

  // ---- setup on a machine without the project

  const expected = () => sourceFiles.filter((f) => f.exists).map((f) => f.path);

  async function refresh(): Promise<void> {
    if (!target) return;
    check = await sc.setupCheck(target, slug, expected());
    if (check.cloned && !targetFiles.length) targetFiles = await sc.setupFiles(target, slug);
    // a step the user did not pick by hand moves on once it is done
    if (step !== "check" && step !== "move" && stepDone(step, check, filesDone)) step = nextStep(check, filesDone, installSkipped);
    schedule();
  }

  /** While a clone or install runs, the checklist is asked again every 2 s. */
  function schedule(): void {
    clearTimeout(timer);
    if (closed || !check || !(check.jobs.clone?.running || check.jobs.install?.running)) return;
    timer = setTimeout(() => {
      refresh()
        .catch((err) => {
          failure = { step, text: errorText(err), retry: () => act(step, refresh) };
        })
        .finally(() => !closed && paint());
    }, 2000);
  }

  function preselect(): void {
    picked.clear();
    overwrite.clear();
    for (const r of copyRows(sourceFiles, targetFiles)) if (!r.onTarget) picked.add(r.file.path);
  }

  function startSetup(to: string): void {
    mode = "setup";
    target = to;
    check = null;
    targetFiles = [];
    filesDone = false;
    installSkipped = false;
    act("setup", async () => {
      sourceFiles = await sc.setupFiles(source, slug);
      await refresh();
      preselect();
      if (check) step = nextStep(check, filesDone, installSkipped);
    });
  }

  const clone = () =>
    act("clone", async () => {
      if (!target) return;
      await sc.setupClone(target, slug);
      await refresh();
    });

  const copy = () =>
    act("files", async () => {
      if (!target) return;
      const rows = copyRows(sourceFiles, targetFiles);
      const paths = rows.filter((r) => (r.onTarget ? overwrite.has(r.file.path) : picked.has(r.file.path))).map((r) => r.file.path);
      if (paths.length) {
        // contents live only in this call: read from the source, written to the target, then dropped
        const files = await sc.setupFilesRead(source, slug, paths);
        await sc.setupFilesWrite(target, slug, files, rows.some((r) => r.onTarget && paths.includes(r.file.path)));
      }
      filesDone = true;
      targetFiles = await sc.setupFiles(target, slug);
      preselect();
      step = "files";
      await refresh();
      if (check) step = nextStep(check, filesDone, installSkipped);
    });

  const install = () =>
    act("install", async () => {
      if (!target) return;
      step = "install";
      await sc.setupInstall(target, slug);
      await refresh();
    });

  const finish = () =>
    act("move", async () => {
      if (!target) return;
      const list = await sc.projects(target, true);
      state.machineProjects.set(target, list);
      if (!list.some((p) => p.slug === slug && !p.error))
        throw new Error(`${projectName} steht auf ${label(target)} noch nicht in der Projektliste – fehlt .lul-workr.json?`);
      await hooks.reloadQueues();
      await moveQueue(target);
    });

  // ---- views

  const ticketsText = (to: string | null) => {
    const n = opts.tickets;
    const where = to ? `der Warteschlange von ${label(to)}` : "der Warteschlange des Zielrechners";
    return `${n} ${n === 1 ? "Ticket" : "Tickets"} von ${label(source)} ${n === 1 ? "wechselt" : "wechseln"} ans Ende ${where}. Hier bleibt sie leer.`;
  };

  function targetRow(t: SwitchTarget): HTMLElement {
    const [tone, ico, text] = KIND_PILL[t.kind];
    const here = projectOn(t.server.id, slug);
    const sub =
      t.kind === "ready" && here
        ? h("span", { class: "ms-target-sub mono" }, `${homeShort(here.root)} · ${here.defaultBranch}`)
        : t.kind === "setup"
          ? h("span", { class: "ms-target-sub" }, `${projectName} ist dort noch nicht geklont`)
          : t.kind === "busy"
            ? h("span", { class: "ms-target-sub" }, icon(ICON.lock, "ms-sub-ico"), `${t.reason} – verschieben geht erst nach dem Lauf`)
            : null;
    const action =
      t.kind === "ready" || t.kind === "busy"
        ? h(
            "button",
            { class: `btn${t.kind === "ready" ? " primary" : ""}`, type: "button", disabled: busy || t.kind === "busy", onclick: () => act("pick", () => moveQueue(t.server.id)) },
            "Hierhin verschieben",
          )
        : t.kind === "setup"
          ? h("button", { class: "btn", type: "button", disabled: busy, onclick: () => startSetup(t.server.id) }, `Auf ${t.server.label} einrichten`)
          : null;
    return h(
      "li",
      { class: "ms-target", "data-kind": t.kind },
      h("span", { class: "ms-target-main" }, h("span", { class: "ms-target-name" }, t.server.label), sub),
      h("span", { class: "ms-target-pill" }, pill(tone, ico, text)),
      action ? h("span", { class: "ms-target-act" }, action) : null,
    );
  }

  function pickView(): Part[] {
    const targets = switchTargets(state.servers, source, (id) => !!projectOn(id, slug), state.statuses);
    return [
      h("h3", { class: "ms-h" }, "Zielrechner"),
      targets.length ? h("ul", { class: "ms-targets", "aria-label": "Zielrechner" }, ...targets.map(targetRow)) : h("p", { class: "muted" }, "Kein anderer Rechner gekoppelt."),
      errorEl("pick"),
    ];
  }

  function stepper(): HTMLElement {
    const at = SETUP_STEPS.findIndex((s) => s.id === (mode === "done" ? "move" : step));
    return h(
      "ol",
      { class: "ms-steps", "aria-label": "Schritte" },
      ...SETUP_STEPS.map((s, i) => {
        const current = mode !== "done" && i === at;
        const done = mode === "done" || (!current && (check && s.id !== "check" && s.id !== "move" ? stepDone(s.id, check, filesDone) : i < at));
        const st = current ? (failure && (failure.step === s.id || failure.step === "setup") ? "error" : "current") : done ? "done" : "todo";
        return h(
          "li",
          { class: "ms-step", "data-state": st, "aria-current": current ? "step" : undefined },
          h("span", { class: "ms-step-dot" }, st === "done" ? icon(ICON.check, "ms-step-ico") : String(i + 1)),
          h("span", { class: "ms-step-label" }, s.label),
        );
      }),
    );
  }

  const stepTitle = (n: number, text: string) => h("h3", { class: "ms-h" }, `${n} · ${text}`);

  function progress(text: string): HTMLElement {
    return h("p", { class: "ms-progress" }, icon(ICON.loader, "ms-spin"), text);
  }

  function jobFailed(text: string): HTMLElement {
    return h("div", { class: "ms-error", role: "alert" }, h("p", { class: "ms-error-text" }, icon(ICON.alert, "ms-error-ico"), h("span", {}, text)));
  }

  function cloneView(c: SetupCheck): Part[] {
    const job = c.jobs.clone;
    const failed = job && !job.running && job.exit !== 0 && !c.cloned;
    return [
      stepTitle(1, "Projekt klonen"),
      h(
        "dl",
        { class: "ms-kv" },
        h("dt", {}, "Zielordner"),
        h("dd", { class: "mono" }, homeShort(c.path)),
        h("dt", {}, "Branch"),
        h("dd", {}, h("span", { class: "mono" }, defaultBranch), ` (Standard-Branch von ${slug})`),
      ),
      job?.running ? progress("wird geklont …") : null,
      failed ? jobFailed(`Klonen fehlgeschlagen (Exit ${job.exit}).`) : null,
      jobLog(job, "Protokoll"),
      // a failed start offers „Erneut versuchen“ in its error box instead
      failure?.step === "clone"
        ? null
        : h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", disabled: busy || !!job?.running, onclick: clone }, failed ? "Erneut klonen" : "Klonen")),
      errorEl("clone"),
    ];
  }

  function filesView(): Part[] {
    const rows = copyRows(sourceFiles, targetFiles);
    const count = rows.filter((r) => (r.onTarget ? overwrite.has(r.file.path) : picked.has(r.file.path))).length;
    const toggle = (set: Set<SetupFilePath>, path: SetupFilePath) => (e: Event) => {
      if ((e.target as HTMLInputElement).checked) set.add(path);
      else set.delete(path);
      paint();
    };
    const box = (file: SetupFileInfo, onTarget: boolean) => {
      const input = h("input", {
        type: "checkbox",
        checked: onTarget ? overwrite.has(file.path) : picked.has(file.path),
        disabled: busy,
        "aria-label": onTarget ? `${file.path} überschreiben` : `${file.path} kopieren`,
        onchange: toggle(onTarget ? overwrite : picked, file.path),
      });
      return h("label", { class: "ms-file-pick" }, input, onTarget ? "überschreiben" : null);
    };
    return [
      stepTitle(2, `Lokale Dateien von ${label(source)} kopieren?`),
      h("p", { class: "ms-text muted" }, `Diese Dateien sind nicht eingecheckt. Wähl aus, was ${label(target)} bekommen soll.`),
      rows.length
        ? h(
            "div",
            { class: "ms-files", role: "table", "aria-label": "Lokale Dateien" },
            h("div", { class: "ms-file ms-file-head", role: "row" }, ...["Kopieren", "Datei", "Größe", "Hinweis"].map((t) => h("span", { role: "columnheader" }, t))),
            ...rows.map(({ file, onTarget }) =>
              h(
                "div",
                { class: "ms-file", role: "row" },
                h("span", { class: "ms-file-cell-pick", role: "cell" }, box(file, onTarget)),
                h("span", { class: "ms-file-name mono", role: "cell" }, file.path),
                h("span", { class: "ms-file-size", role: "cell" }, sizeText(file.size)),
                h(
                  "span",
                  { class: "ms-file-note", role: "cell" },
                  file.secret
                    ? h(
                        "span",
                        { class: "ms-file-secret" },
                        icon(ICON.lock, "ms-sub-ico"),
                        h("span", {}, file.keys.length ? "enthält Geheimnisse: " : "enthält Geheimnisse", file.keys.length ? h("span", { class: "mono" }, file.keys.join(", ")) : null),
                      )
                    : null,
                  onTarget ? h("span", { class: "ms-file-there" }, "auf Ziel vorhanden") : null,
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, `${label(source)} hat keine dieser Dateien.`),
      h("p", { class: "ms-hint" }, icon(ICON.info, "ms-sub-ico"), "Inhalte gehen direkt von Rechner zu Rechner, werden nicht protokolliert; .env-Dateien bekommen Rechte 600."),
      h(
        "div",
        { class: "btn-row" },
        h("button", { class: "btn primary", type: "button", disabled: busy || !count, onclick: copy }, "Ausgewählte kopieren"),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: busy,
            onclick: () => {
              filesDone = true;
              if (check) step = nextStep(check, filesDone, installSkipped);
              paint();
            },
          },
          "Ohne Kopieren weiter",
        ),
      ),
      errorEl("files"),
    ];
  }

  function installView(c: SetupCheck): Part[] {
    const job = c.jobs.install;
    const failed = job && !job.running && job.exit !== 0;
    const pm = c.pm;
    return [
      stepTitle(3, "Abhängigkeiten installieren"),
      h(
        "p",
        { class: "ms-text" },
        pm ? `${pm.name}${pm.version ? ` ${pm.version}` : ""} (${pm.lockfile ?? "package.json"}) installiert die Abhängigkeiten auf ${label(target)}.` : "Kein package.json – nichts zu installieren.",
      ),
      job?.running ? progress("wird installiert …") : null,
      failed ? jobFailed(`Installation fehlgeschlagen (Exit ${job.exit}).`) : null,
      jobLog(job, "Protokoll"),
      h(
        "div",
        { class: "btn-row" },
        h("button", { class: "btn primary", type: "button", disabled: busy || !!job?.running || !pm, onclick: install }, failed ? "Erneut installieren" : "Abhängigkeiten installieren"),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: busy || !!job?.running,
            onclick: () => {
              installSkipped = true;
              step = "check";
              paint();
            },
          },
          "Überspringen",
        ),
      ),
      errorEl("install"),
    ];
  }

  function fixButton(i: CheckItem, c: SetupCheck): HTMLElement | null {
    if (i.ok || !i.fix) return null;
    const go = (to: SetupStep) => () => {
      step = to;
      paint();
    };
    if (i.fix === "install")
      return h("button", { class: "btn", type: "button", disabled: busy || !!c.jobs.install?.running || !c.cloned, onclick: install }, "Abhängigkeiten installieren");
    if (i.fix === "files") return h("button", { class: "btn", type: "button", disabled: busy || !c.cloned, onclick: go("files") }, "Dateien kopieren");
    return h("button", { class: "btn", type: "button", disabled: busy, onclick: go("clone") }, "Klonen");
  }

  function checkView(c: SetupCheck): Part[] {
    return [
      stepTitle(4, `Prüfung auf ${label(target)}`),
      h("p", { class: "ms-text muted" }, checkSummary(c.items)),
      h(
        "ul",
        { class: "ms-checks" },
        ...c.items.map((i) => {
          const st = i.ok ? "ok" : i.hint ? "hint" : "missing";
          return h(
            "li",
            { class: "ms-check", "data-state": st },
            h(
              "span",
              { class: "ms-check-mark", role: "img", "aria-label": st === "ok" ? "ok" : st === "hint" ? "Hinweis" : "fehlt" },
              icon(st === "ok" ? ICON.check : st === "hint" ? ICON.info : ICON.x, "ms-check-ico"),
            ),
            h("span", { class: "ms-check-text" }, h("span", { class: "ms-check-label" }, i.label), h("span", { class: "ms-check-detail" }, i.detail)),
            fixButton(i, c),
          );
        }),
      ),
      h(
        "div",
        { class: "btn-row" },
        h("button", { class: "btn primary", type: "button", disabled: busy || !c.cloned, onclick: finish }, "Projekt einlesen und verschieben"),
        h("button", { class: "btn", type: "button", disabled: busy, onclick: () => act("check", refresh) }, "Erneut prüfen"),
      ),
      errorEl("check"),
      errorEl("move"),
    ];
  }

  function setupView(): Part[] {
    if (!check) return [progress(`Prüfe ${label(target)} …`), errorEl("setup")];
    const c = check;
    const content = step === "clone" ? cloneView(c) : step === "files" ? filesView() : step === "install" ? installView(c) : checkView(c);
    return [stepper(), ...content, errorEl("setup")];
  }

  function doneView(): Part[] {
    const to = target ?? "";
    return [
      h(
        "div",
        { class: "ms-done", role: "status" },
        icon(ICON.check, "ms-done-ico"),
        h("p", { class: "ms-done-title" }, `${moved} ${moved === 1 ? "Ticket" : "Tickets"} jetzt auf ${label(to)} – dort „Lauf starten“.`),
        h("p", { class: "ms-done-text" }, `Die Warteschlange auf ${label(source)} ist leer. Der Lauf startet nicht von selbst.`),
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            {
              class: "btn primary",
              type: "button",
              onclick: () => {
                close();
                opts.openPanel(to);
              },
            },
            `Lauf-Panel von ${label(to)} öffnen`,
          ),
          h("button", { class: "btn", type: "button", onclick: close }, "Schließen"),
        ),
      ),
    ];
  }

  function paint(): void {
    if (closed) return;
    const title = mode === "setup" ? `${projectName} auf ${label(target)} einrichten` : mode === "done" ? "Warteschlange umgezogen" : "Warteschlange umziehen";
    const sub = mode === "done" ? null : h("p", { class: "ms-sub" }, ticketsText(mode === "setup" ? target : null));
    const foot =
      mode === "setup"
        ? h(
            "div",
            { class: "ms-foot" },
            h(
              "button",
              {
                class: "link ms-back",
                type: "button",
                disabled: busy,
                onclick: () => {
                  clearTimeout(timer);
                  mode = "pick";
                  failure = null;
                  paint();
                },
              },
              "← Anderen Rechner wählen",
            ),
          )
        : null;
    // a fresh box each time: WebKit left the text of a shrinking scroll box unpainted when only its children changed
    fill(
      overlay,
      h(
        "div",
        { class: "modal ms", role: "dialog", "aria-modal": "true", "aria-labelledby": "ms-heading" },
        h(
          "div",
          { class: "ms-head" },
          h("div", { class: "ms-head-text" }, h("h2", { id: "ms-heading" }, title), sub),
          h("button", { class: "btn ghost", type: "button", "aria-label": "Schließen", onclick: close }, "✕"),
        ),
        h("div", { class: "ms-body" }, ...(mode === "pick" ? pickView() : mode === "setup" ? setupView() : doneView())),
        foot,
      ),
    );
  }

  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  paint();
}
