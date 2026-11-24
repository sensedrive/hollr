/**
 * „Was passiert gerade“ for one run (Läufe, design v23): the seven stations of the skill lul-workr-run-sandcastle
 * with their state, the step for the machine's status block and a plain-language sentence. From the run's batch
 * flow (Ablauf-Log v1) when it has one; without, from what the status knows (phases from events/logs, loop ended,
 * PR) – stations nothing tells about stay „unknown“. No DOM – tested in timeline.test.ts.
 */
import type { Flow, Phase, Run } from "./types";

export type StationState = "done" | "current" | "waiting" | "failed" | "skipped" | "todo" | "unknown";

export const STATIONS = [
  { id: "start", label: "Start", detail: "Sperre setzen, Branch anlegen" },
  { id: "vorpruefung", label: "Vorprüfung", detail: "Warteschlange lesen, Blocker prüfen" },
  { id: "schleife", label: "Schleife: Ticket für Ticket", detail: "Planer, Implementer, Code-Review, Merge je Ticket" },
  { id: "pruefungen", label: "Prüfungen", detail: "Tests, Lint und Typen über alle Änderungen" },
  { id: "pr", label: "PR", detail: "Pull-Request öffnen" },
  { id: "testserver", label: "Testserver", detail: "Testserver starten, Testanweisung schreiben" },
  { id: "bericht", label: "Bericht", detail: "Zusammenfassung in JIRA und Hollr" },
] as const;

export type StationId = (typeof STATIONS)[number]["id"];

export interface Station {
  id: StationId;
  label: string;
  detail: string;
  state: StationState;
  /** why a stage failed (flow) */
  reason: string | null;
}

/** Pill text per phase: the step the ticket stands at. */
export const PHASE_PILL: Readonly<Record<Phase, string>> = {
  queued: "wartet",
  planned: "geplant",
  building: "Implementer",
  reviewing: "Code-Review",
  merged: "gemergt",
  failed: "fehlgeschlagen",
  "no-commits": "ohne Commits",
};

const stageState = (flow: Flow, stage: string) => flow.stages.find((s) => s.stage === stage);

/** A flow stage → its station state. */
function fromStage(state: string | undefined): StationState {
  return state === "ok" ? "done" : state === "running" ? "current" : state === "failed" ? "failed" : state === "skipped" ? "skipped" : "todo";
}

function flowStations(flow: Flow): StationState[] {
  const st = (s: string) => fromStage(stageState(flow, s)?.state);
  const sandcastle = st("sandcastle");
  const worktree = st("worktree");
  // no stage of its own: between the worktree and the loop
  const pre: StationState = sandcastle !== "todo" ? "done" : worktree === "done" ? (flow.endedAt ? "todo" : "current") : "todo";
  const deploy = st("deploy");
  const plan = st("testplan");
  const test: StationState = [deploy, plan].includes("failed")
    ? "failed"
    : [deploy, plan].includes("current")
      ? "current"
      : deploy === "skipped" && plan !== "done"
        ? "skipped"
        : [deploy, plan].every((s) => s === "done" || s === "skipped")
          ? "done"
          : "todo";
  const report: StationState = flow.endedAt
    ? flow.outcome === "ok"
      ? "done"
      : "todo"
    : test === "done" || test === "skipped"
      ? "current"
      : "todo";
  return [worktree, pre, sandcastle, st("checks"), st("pr"), test, report];
}

/** Without a flow: only what the status knows. A run with no events (a fixed scope, or a skill that builds in a
 *  worktree of its own) tells nothing past its start – its stations stay „unknown“, never a guessed step. */
function statusStations(run: Run): StationState[] {
  const ended = run.status === "ended";
  const loopDone = run.status === "loop-ended" || ended;
  const loopStarted = loopDone || run.issues.some((i) => i.phase !== "queued");
  if (!loopStarted) return ["done", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"];
  const afterLoop: StationState = run.pr ? "done" : "unknown";
  return [
    "done",
    "done",
    loopDone ? "done" : "current",
    loopDone ? afterLoop : "todo",
    loopDone ? afterLoop : "todo",
    loopDone ? "unknown" : "todo",
    loopDone ? "unknown" : "todo",
  ];
}

/** The stations with their states; a run waiting for an answer waits at its current (with a flow: else next open) station. */
export function timeline(run: Run): Station[] {
  const states = run.flow ? flowStations(run.flow) : statusStations(run);
  if (run.status === "waiting") {
    const at = states.indexOf("current");
    const i = at >= 0 || !run.flow ? at : states.findIndex((s) => s === "todo" || s === "unknown");
    if (i >= 0) states[i] = "waiting";
  }
  if (run.status === "ended") for (let i = 0; i < states.length; i++) if (states[i] === "current") states[i] = "unknown";
  return STATIONS.map((s, i) => {
    const stage = run.flow ? stageState(run.flow, ["worktree", "", "sandcastle", "checks", "pr", "deploy", ""][i] ?? "") : undefined;
    return { id: s.id, label: s.label, detail: s.detail, state: states[i] ?? "unknown", reason: stage?.reason ?? null };
  });
}

/** The station the run stands at (current or waiting), null when none is known. */
export const currentStation = (stations: Station[]) => stations.find((s) => s.state === "current" || s.state === "waiting") ?? null;

const nums = (ns: number[]) => ns.map((n) => `#${n}`).join(", ").replace(/, ([^,]*)$/, " und $1");

/** „Implementer an #603“, „Planer“, „Merge“ … – what the machine's status block names as the step. */
export function stepText(run: Run, stations: Station[] = timeline(run)): string {
  const active = run.flow?.active ?? [];
  const role = active.find((r) => r.role === "implementer" || r.role === "reviewer") ?? active[0];
  if (role) {
    const at = role.assignment !== null ? ` an #${role.assignment}` : "";
    return { planner: "Planer", implementer: `Implementer${at}`, reviewer: `Code-Review${at}`, merger: "Merge" }[role.role];
  }
  const building = run.issues.find((i) => i.phase === "building");
  if (building) return `Implementer an #${building.n}`;
  const reviewing = run.issues.find((i) => i.phase === "reviewing");
  if (reviewing) return `Code-Review an #${reviewing.n}`;
  const at = currentStation(stations);
  if (!at) return run.status === "loop-ended" ? "Schleife fertig – Prüfungen/PR" : run.agent?.doing ? run.agent.doing : "ohne Angabe";
  return at.label;
}

/** How a run's tickets ended: „6 gemergt, 1 fehlgeschlagen (#617)“. */
function tally(run: Run): string {
  const merged = run.issues.filter((i) => i.phase === "merged").length;
  const failed = run.issues.filter((i) => i.phase === "failed" || i.phase === "no-commits").map((i) => i.n);
  return `${merged} gemergt${failed.length ? `, ${failed.length} fehlgeschlagen (${nums(failed)})` : ""}`;
}

/** The loop at work: who is built, who is reviewed, what follows, what waits for a blocker. */
function loopText(run: Run, openBlockers: (n: number) => number[]): string {
  const of = (p: Phase) => run.issues.filter((i) => i.phase === p).map((i) => i.n);
  const building = of("building");
  const reviewing = of("reviewing");
  const planned = of("planned");
  const parts: string[] = [];
  if (building.length) parts.push(`${nums(building)} ${building.length > 1 ? "werden" : "wird"} gerade gebaut`);
  if (reviewing.length) parts.push(`${nums(reviewing)} ${reviewing.length > 1 ? "sind" : "ist"} im Code-Review`);
  if (planned.length) parts.push(`${nums(planned)} ${planned.length > 1 ? "sind" : "ist"} geplant`);
  const queued = of("queued");
  const blocked = queued.map((n) => [n, openBlockers(n)] as const).filter(([, b]) => b.length);
  const next = queued.find((n) => !blocked.some(([b]) => b === n));
  const then = [next !== undefined ? `Danach folgt #${next}` : "", ...blocked.map(([n, b]) => `#${n} wartet auf ${nums(b)}`)].filter(Boolean).join("; ");
  const now = parts.length ? `Der Agent baut Ticket für Ticket: ${parts.join(", ")}.` : "Der Planer wählt die nächsten Tickets.";
  return then ? `${now} ${then}.` : now;
}

const STATION_NOW: Partial<Record<StationId, string>> = {
  start: "Der Agent setzt die Sperre und legt Branch und Arbeitsordner an.",
  vorpruefung: "Der Agent liest die Warteschlange und prüft Blocker.",
  pruefungen: "Jetzt laufen Tests, Lint und Typen über alle Änderungen.",
  pr: "Jetzt öffnet der Agent den Pull-Request.",
  testserver: "Der PR ist offen. Jetzt startet der Agent den Testserver und schreibt die Testanweisung.",
  bericht: "Jetzt schreibt der Agent die Zusammenfassung in JIRA und Hollr.",
};

/** The plain-language sentence under „Was passiert gerade“ (or „So ist der Lauf verlaufen“). */
export function clearText(run: Run, stations: Station[], openBlockers: (n: number) => number[]): string {
  const total = run.issues.length;
  const done = total ? `Alle ${total} Tickets sind durch: ${tally(run)}.` : "";
  if (run.status === "ended") {
    const failed = stations.find((s) => s.state === "failed");
    return [`Der Lauf ist beendet${total ? `: ${tally(run)}` : ""}.`, run.pr ? `PR #${run.pr}.` : "", failed ? `${failed.label} ist fehlgeschlagen${failed.reason ? `: ${failed.reason}` : ""}.` : ""]
      .filter(Boolean)
      .join(" ");
  }
  const failed = stations.find((s) => s.state === "failed");
  if (failed && !currentStation(stations)) return `${failed.label} ist fehlgeschlagen${failed.reason ? `: ${failed.reason}` : ""}.`;
  const at = currentStation(stations);
  if (!at && !run.flow && run.status !== "loop-ended")
    return "Dieser Lauf schreibt noch kein Ablauf-Log – welcher Schritt gerade läuft, weiß das Board nicht. Was der Agent zuletzt geschrieben hat, steht darunter.";
  if (!at) return [done, "Die Schleife ist fertig. Danach prüft der Agent, öffnet den PR und – je nach Wahl – einen Testserver; welcher Schritt gerade läuft, meldet dieser Lauf nicht."].filter(Boolean).join(" ");
  if (at.id === "schleife") return loopText(run, openBlockers);
  if (at.id === "start" || at.id === "vorpruefung") return STATION_NOW[at.id] ?? "";
  return [done, STATION_NOW[at.id] ?? ""].filter(Boolean).join(" ");
}

/** Tickets the run is through with: merged, failed or without commits. */
export const finishedCount = (run: Run) => run.issues.filter((i) => i.phase === "merged" || i.phase === "failed" || i.phase === "no-commits").length;

/** „Ticket 4 von 7“ for the loop station: the next one the run is not through with. */
export function loopPosition(run: Run): string {
  const total = run.issues.length;
  return total ? `Ticket ${Math.min(finishedCount(run) + 1, total)} von ${total}` : "";
}
