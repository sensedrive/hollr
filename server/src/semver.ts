/**
 * Version ranges as far as a project's `lulWorkr` (`.lul-workr.json`) needs them: exact (`1.1.0`, `=1.1.0`),
 * `^`, `~`, partial versions (`1`, `1.1`, `1.x`, `*`), several comparators joined by spaces (and) or `||` (or).
 * A minimal port of lul-workr-init `engine/src/semver.ts`, which decides whether the loop may run; a pre-release
 * (`1.2.0-rc.1`) satisfies a range only through a bound that names the same core version with a pre-release.
 */

interface Version {
  core: [number, number, number];
  pre: string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  // without a pre-release is greater
  if (!a.length || !b.length) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return (a.core[i] ?? 0) - (b.core[i] ?? 0);
  return comparePre(a.pre, b.pre);
}

type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator {
  op: Op;
  v: Version;
}

const ver = (major: number, minor: number, patch: number, pre: string[] = []): Version => ({
  core: [major, minor, patch],
  pre,
});
/** the lowest version of a line: below every 2.0.0 pre-release */
const floor = (major: number, minor: number, patch: number) => ver(major, minor, patch, ["0"]);

function comparators(token: string): Comparator[] | null {
  if (["", "*", "x", "X"].includes(token)) return [];
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(
    token,
  );
  if (!m) return null;
  const op = m[1] ?? "";
  const num = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const major = num(m[2]);
  const minor = num(m[3]);
  const patch = num(m[4]);
  const pre = m[5] ? m[5].split(".") : [];
  if (major === null) return [];
  const lo = ver(major, minor ?? 0, patch ?? 0, pre);
  if (op === "^") {
    const hi =
      major > 0 || minor === null
        ? floor(major + 1, 0, 0)
        : minor > 0 || patch === null
          ? floor(0, minor + 1, 0)
          : floor(0, 0, patch + 1);
    return [
      { op: ">=", v: lo },
      { op: "<", v: hi },
    ];
  }
  const next = minor === null ? floor(major + 1, 0, 0) : floor(major, minor + 1, 0);
  if (op === "~")
    return [
      { op: ">=", v: lo },
      { op: "<", v: next },
    ];
  if (minor === null || patch === null) {
    // a partial version is the whole line: 1.1 = >=1.1.0 <1.2.0-0
    if (op === "" || op === "=")
      return [
        { op: ">=", v: lo },
        { op: "<", v: next },
      ];
    if (op === ">") return [{ op: ">=", v: next }];
    if (op === "<=") return [{ op: "<", v: next }];
    return [{ op: op as Op, v: lo }];
  }
  return [{ op: op === "" ? "=" : (op as Op), v: lo }];
}

function holds(c: Comparator, v: Version): boolean {
  const d = compareVersions(v, c.v);
  if (c.op === "<") return d < 0;
  if (c.op === "<=") return d <= 0;
  if (c.op === ">") return d > 0;
  if (c.op === ">=") return d >= 0;
  return d === 0;
}

/** The range's alternatives (`||`), each a list of comparators that must all hold; null when unreadable. */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.split("||")) {
    const set: Comparator[] = [];
    for (const token of alt
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .split(/\s+/)) {
      const c = comparators(token);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

/** Does `version` satisfy `range`? Anything unreadable is false. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const sets = parseRange(range);
  if (!v || !sets) return false;
  return sets.some(
    (set) =>
      set.every((c) => holds(c, v)) &&
      (!v.pre.length ||
        set.some(
          (c) => c.v.pre.length > 0 && c.v.pre[0] !== "0" && c.v.core.every((n, i) => n === v.core[i]),
        )),
  );
}
