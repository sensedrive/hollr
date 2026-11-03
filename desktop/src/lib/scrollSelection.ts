// Selecting past the terminal's edge in a session: herdr's attach is a full-screen TUI without scrollback
// in xterm, so a drag above/below the screen makes Hollr scroll herdr (mouse wheel) and collect the text
// that scrolls by. Each new screen is placed in the text collected so far by its matching lines.

/** a position in the collected text */
export interface Cell {
  line: number;
  col: number;
}

/** share of the overlapping non-blank lines that must match for a screen to count as scrolled */
const MATCH = 0.8;
/** fewest matching non-blank lines that place a screen */
const MIN_MATCHES = 3;

export class ScrollSelection {
  /** the text so far, top to bottom */
  readonly lines: string[];
  /** where the screen's first row is in `lines` */
  top = 0;
  readonly anchor: Cell;

  /** `screen`: the rows on screen when the drag left it; the drag started at `row`/`col` */
  constructor(screen: string[], row: number, col: number) {
    this.lines = screen.slice();
    this.anchor = { line: row, col };
  }

  /**
   * A newly drawn screen: placed by its lines that match the text so far (scrolled up or down), the lines
   * new to it added. False: it matches nowhere – a frame half drawn, or the program redrew everything.
   */
  update(screen: string[]): boolean {
    const top = this.place(screen);
    if (top === null) return false;
    if (top < 0) {
      this.lines.unshift(...screen.slice(0, -top));
      this.anchor.line -= top;
      this.top = 0;
    } else this.top = top;
    const end = this.top + screen.length;
    if (end > this.lines.length) this.lines.push(...screen.slice(screen.length - (end - this.lines.length)));
    return true;
  }

  /** where `screen` sits in `lines` (may start above them); null when it doesn't */
  private place(screen: string[]): number | null {
    let best: { top: number; matches: number } | null = null;
    for (let d = 0; d < screen.length; d++) {
      for (const top of d ? [this.top - d, this.top + d] : [this.top]) {
        let compared = 0;
        let matches = 0;
        for (let r = 0; r < screen.length; r++) {
          const known = this.lines[top + r];
          if (known === undefined || !screen[r].trim()) continue;
          compared++;
          if (known === screen[r]) matches++;
        }
        if (matches < Math.min(MIN_MATCHES, compared) || !compared || matches / compared < MATCH) continue;
        if (!best || matches > best.matches) best = { top, matches };
      }
    }
    return best?.top ?? null;
  }

  /** the drag's end at screen `row`/`col`: above the screen it is the first line's start, below the last's end */
  point(row: number, col: number, rows: number): Cell {
    if (row < 0) return { line: this.top, col: 0 };
    if (row >= rows) return { line: this.top + rows - 1, col: Number.POSITIVE_INFINITY };
    return { line: this.top + row, col };
  }

  /** anchor and `p` in reading order */
  range(p: Cell): [Cell, Cell] {
    const a = this.anchor;
    return a.line < p.line || (a.line === p.line && a.col <= p.col) ? [a, p] : [p, a];
  }

  /** the text from the anchor to `p`: the cell under `p` is in, the anchor cell only when the drag went forward
   *  (like a terminal: dragging up from a cell selects up to it) */
  text(p: Cell): string {
    const [s, e] = this.range(p);
    const end = e === this.anchor ? e.col : e.col + 1;
    if (s.line === e.line) return this.lines[s.line].slice(s.col, end);
    return [
      this.lines[s.line].slice(s.col),
      ...this.lines.slice(s.line + 1, e.line),
      this.lines[e.line].slice(0, end),
    ].join("\n");
  }
}

/** A selection as plain text: without the blanks a TUI pads its lines with, its left margin (the indent all
 *  following lines share – the first one starts where the drag did) and trailing empty lines. */
export function cleanSelection(raw: string): string {
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/, ""));
  const rest = lines.slice(1).filter(Boolean);
  const indent = rest.length ? Math.min(...rest.map((l) => l.match(/^ */)?.[0].length ?? 0)) : 0;
  return lines
    .map((l, i) => (i === 0 ? l.trimStart() : l.slice(indent)))
    .join("\n")
    .replace(/\n+$/, "");
}
