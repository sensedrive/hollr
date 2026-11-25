/**
 * The Versionen view's model (pure): per project and machine, does the machine's lul-workr carry the project's loop?
 * Facts come from gate `sandcastle` (`projects[].lulWorkr`, `status.machine.lulWorkr`) and gate `tools` (newest
 * release, the update job), the same gate the Werkzeuge screen uses.
 */
import type { LulWorkrFacts, Project, Server } from "./types";

/** ok = installed satisfies the range; update = it does, but a newer release exists; unmet = it doesn't. */
export type CellState = "ok" | "update" | "unmet" | "forked" | "none" | "absent" | "offline" | "unknown";

export interface MachineVersions {
  server: Server;
  /** `lul-workr --version`; null = not installed, undefined = not known (yet) */
  installed: string | null | undefined;
  /** newest release; undefined = unknown */
  latest?: string;
  /** the machine's projects or status didn't answer: its column shows no state */
  error: string | null;
}

export interface VersionRow {
  slug: string;
  name: string;
  /** forked as soon as one machine still has its own loop; else bundle with the range; else none */
  mode: LulWorkrFacts["mode"] | null;
  range: string | null;
}

/** "1.10.2" > "1.9.9"; prefixes like "v" are ignored (server tools.ts `newer`). */
export function newer(a: string | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const parse = (v: string) => (v.match(/\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export function cellState(p: Project | undefined, m: MachineVersions): CellState {
  if (!m.server.online) return "offline";
  if (m.error) return "unknown";
  if (!p) return "absent";
  // a machine with an older hollr knows no mode
  if (!p.lulWorkr) return "unknown";
  if (p.lulWorkr.mode !== "bundle") return p.lulWorkr.mode;
  if (p.lulWorkr.satisfied === false) return "unmet";
  return newer(m.latest, m.installed) ? "update" : "ok";
}

export function cellLabel(s: CellState, p: Project | undefined, m: MachineVersions): string {
  const range = p?.lulWorkr?.required ?? "";
  switch (s) {
    case "ok":
      return range || "passt";
    case "update":
      return `${range} · neu ${m.latest}`;
    case "unmet":
      return `${range} · hat ${m.installed ?? "keins"}`;
    case "forked":
      return "abgezweigt";
    case "none":
      return "ohne Bereich";
    case "absent":
      return "nicht ausgecheckt";
    case "offline":
      return "offline";
    case "unknown":
      return m.error ? "keine Antwort" : "unbekannt";
  }
}

/** One row per repo any machine has checked out, by name. */
export function versionRows(machines: Map<string, Project[]>): VersionRow[] {
  const rows = new Map<string, VersionRow>();
  for (const list of machines.values())
    for (const p of list) {
      if (p.error || !p.slug) continue;
      const row = rows.get(p.slug) ?? { slug: p.slug, name: p.name, mode: null, range: null };
      const f = p.lulWorkr;
      if (f?.mode === "forked") row.mode = "forked";
      else if (f?.mode === "bundle" && row.mode !== "forked") {
        row.mode = "bundle";
        row.range ??= f.required;
      } else if (f?.mode === "none" && !row.mode) row.mode = "none";
      rows.set(p.slug, row);
    }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** „10 Projekte · 1 auf dem Bundle, 9 noch abgezweigt · 1 Bereich nicht erfüllt“ */
export function summary(rows: VersionRow[], unmet: number): string {
  const bundle = rows.filter((r) => r.mode === "bundle").length;
  const forked = rows.filter((r) => r.mode === "forked").length;
  return `${rows.length} ${rows.length === 1 ? "Projekt" : "Projekte"} · ${bundle} auf dem Bundle, ${forked} noch abgezweigt${
    unmet ? ` · ${unmet} Bereich nicht erfüllt` : ""
  }`;
}
