/** One terminal line in miniature: visible length and the first foreground colour set in it (hex), if any. */
export type MiniLine = [number, string | null];

const BASIC = [
  "#1d1f21",
  "#cc6666",
  "#b5bd68",
  "#f0c674",
  "#81a2be",
  "#b294bb",
  "#8abeb7",
  "#c5c8c6",
];
const BRIGHT = [
  "#666666",
  "#d54e53",
  "#b9ca4a",
  "#e7c547",
  "#7aa6da",
  "#c397d8",
  "#70c0b1",
  "#eaeaea",
];

function xterm256(n: number): string {
  if (n < 8) return BASIC[n] ?? "#888888";
  if (n < 16) return BRIGHT[n - 8] ?? "#888888";
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, "0");
    return `#${v}${v}${v}`;
  }
  const c = n - 16;
  const step = (x: number) => (x ? 55 + x * 40 : 0).toString(16).padStart(2, "0");
  return `#${step(Math.floor(c / 36))}${step(Math.floor(c / 6) % 6)}${step(c % 6)}`;
}

/** The first foreground colour an SGR parameter list sets, or undefined. */
function sgrColor(params: number[]): string | undefined {
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 38 && params[i + 1] === 2 && params.length >= i + 5) {
      return `#${params
        .slice(i + 2, i + 5)
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
    }
    if (p === 38 && params[i + 1] === 5 && params[i + 2] !== undefined)
      return xterm256(params[i + 2] ?? 0);
    if (p === 38 || p === 48) {
      i += params[i + 1] === 2 ? 4 : 2;
      continue;
    }
    if (p >= 30 && p <= 37) return BASIC[p - 30];
    if (p >= 90 && p <= 97) return BRIGHT[p - 90];
  }
  return undefined;
}

/** Per line: length without escapes and trailing blanks, and the first colour used on a visible character. */
export function miniLines(ansi: string, max = 5000): MiniLine[] {
  const lines = ansi.split("\n").slice(-max);
  return lines.map((line) => {
    let color: string | null = null;
    let pending: string | undefined;
    let text = "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
    const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|([^\x1b]+)/g;
    for (const m of line.matchAll(re)) {
      if (m[1] !== undefined) {
        const c = sgrColor(m[1].split(";").map((v) => Number(v) || 0));
        if (c) pending = c;
        else if (m[1] === "" || m[1] === "0" || m[1] === "39") pending = undefined;
      } else if (m[2]) {
        if (!color && pending && m[2].trim()) color = pending;
        text += m[2];
      }
    }
    return [text.trimEnd().length, color];
  });
}
