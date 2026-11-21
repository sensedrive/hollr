<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // A real terminal on the pane (xterm.js, like iOS TerminalView): the pane's own TUI sized to this panel
  // (`hollr gate attach`). Click into it and type: keys go straight in, Cmd shortcuts stay with the app.
  // A dropped connection comes back by itself; Cmd+click opens links and file paths (the preview).
  import { untrack } from "svelte";
  import { Terminal, type ILink } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import "@xterm/xterm/css/xterm.css";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { t } from "../i18n";
  import { gate } from "../api";
  import type { JumpNote } from "../jumpNotes.svelte";
  import TermMinimap from "./TermMinimap.svelte";
  import { findLinks, keySequence, linksAt, TermSession, type TermEnd, type TermPhase } from "../terminal";
  import { findPaths, pathHref } from "../paths";
  import { cleanSelection, ScrollSelection } from "../scrollSelection";
  import { offerSelection, withdrawSelection } from "../speech.svelte";

  let { server, pane, onLink, overview = false, notes = [], onNoteMenu }: {
    server: string; pane: string; onLink?: (href: string) => void;
    /** the overview at the right edge (scrollback in miniature, jump notes as bands) */
    overview?: boolean;
    notes?: JumpNote[];
    onNoteMenu?: (note: JumpNote, x: number, y: number) => void;
  } = $props();

  const mac = navigator.platform.includes("Mac");
  let host: HTMLDivElement | undefined = $state();
  let phase = $state<TermPhase>({ kind: "connecting" });
  let focused = $state(false);
  let term: Terminal | undefined;
  let session: TermSession | undefined;

  /** Cmd+click (Ctrl+click elsewhere) opens a link – a plain click belongs to the TUI. The terminal lets
   *  go of the keyboard so Esc closes the link dialog instead of going to the TUI. */
  function openLink(e: MouseEvent, url: string) {
    if (!(mac ? e.metaKey : e.ctrlKey) || !onLink) return;
    term?.blur();
    onLink(url);
  }

  function closedText(end: TermEnd): string {
    switch (end.why) {
      // herdr's attach ended – mostly taken over by another view (iPhone, another window) or the pane closed; herdr
      // prints why on the screen behind. Not a shell that ended: this view never runs one.
      case "exit": return t("Verbindung beendet.");
      case "gone": return t("Die Session gibt es nicht mehr.");
      case "closed": return t("Die Sitzung wurde geschlossen.");
      case "unsupported": return t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.");
      case "error": return end.error || t("Verbindung beendet.");
    }
  }

  // the dev bridge (normal browser) has no native clipboard plugin behind it
  const viaBridge = new URLSearchParams(location.search).has("bridge");
  let copied = $state(0);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyText(text: string) {
    if (!text) return;
    try {
      if (viaBridge) await navigator.clipboard.writeText(text);
      else await writeText(text);
    } catch {
      return;
    }
    copied++;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = 0), 1400);
  }

  /** Links and file paths in the (wrapped) line at buffer row `y` (1-based), mapped back to their cells. */
  function linksOn(y: number): ILink[] {
    if (!term) return [];
    const buf = term.buffer.active;
    const found = linksAt((row) => buf.getLine(row), buf.length, y, (text) => [
      ...findLinks(text),
      ...findPaths(text).map((p) => ({ start: p.start, end: p.end, url: pathHref(p.path, p.line) })),
    ]);
    return found.map((l) => ({
      range: { start: l.start, end: l.end },
      text: l.text,
      activate: (e: MouseEvent) => {
        openLink(e, l.url);
      },
    }));
  }

  // primitives that only change when they really do: the parent hands `pane` through an object that
  // is new on every poll, which would otherwise restart the terminal each time
  const srv = $derived(server);
  const paneId = $derived(pane);

  $effect(() => {
    const el = host;
    const target = { server: srv, pane: paneId };
    if (!el) return;
    return untrack(() => {
      phase = { kind: "connecting" };
      // another pane: the overview of the last one is not this one's
      mini = null;
      noMap = false;
      dirty = true;
      let framed!: () => void;
      ready = new Promise<void>((r) => (framed = r));
      const css = getComputedStyle(document.documentElement);
      const x = new Terminal({
        fontFamily: css.getPropertyValue("--mono").trim() || "Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.1,
        scrollback: 3000,
        cursorBlink: false,
        // full-screen programs (omp, Claude …) take the mouse: a plain drag still selects text (see
        // forceSelect below), ⌥-click goes to the program; ⌥ stays for typing @ [ ] { } on a Mac
        macOptionClickForcesSelection: true,
        // ⌥-click would otherwise move the prompt cursor with arrow keys
        altClickMovesCursor: false,
        theme: { background: "#0f1216", foreground: "#d7dae0", cursor: "#7aa2f7", selectionBackground: "#3d59a1" },
        // `x.unicode` (the character width table below) is proposed API
        allowProposedApi: true,
        // OSC 8 hyperlinks
        linkHandler: {
          activate: (e, uri) => {
            openLink(e, uri);
          },
        },
      });
      const fit = new FitAddon();
      x.loadAddon(fit);
      // emoji (🚀 ⚡ 👍) two cells wide like herdr, omp and the shells count them – the default Unicode 6
      // table makes them one, which leaves stale characters next to them when herdr redraws a row
      x.loadAddon(new Unicode11Addon());
      x.unicode.activeVersion = "11";
      x.open(el);
      term = x;
      const s = new TermSession({
        ...target,
        onOutput: (data) => x.write(data),
        onPhase: (ph) => (phase = ph),
      });
      session = s;

      x.registerLinkProvider({ provideLinks: (y, done) => done(linksOn(y)) });
      x.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const key = e.key.toLowerCase();
        // Shift+Enter: a new line instead of sending – ESC+CR, the newline omp's and Claude Code's editors
        // take from terminals without the kitty keyboard protocol (xterm.js sends a plain CR otherwise)
        if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          s.type("\x1b\r");
          return false;
        }
        const copy = mac ? e.metaKey && key === "c" : e.ctrlKey && key === "c" && x.hasSelection();
        if (copy) {
          void copyText(cleanSelection(x.getSelection()));
          return false;
        }
        // Cmd shortcuts stay with the app (Cmd+V arrives as a paste, which xterm types in)
        if (e.metaKey) return false;
        // Windows/Linux: Ctrl+V pastes
        if (!mac && e.ctrlKey && key === "v") return false;
        return true;
      });
      // xterm selects only with the "force selection" key (⌥ on a Mac, ⇧ elsewhere) while the program
      // takes the mouse. Swapped here: a plain left drag/click selects, with that key it goes to the program.
      const forceKey = mac ? "altKey" : "shiftKey";
      const forceSelect = (e: MouseEvent) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || !x.modes.mouseTrackingMode || x.modes.mouseTrackingMode === "none") return;
        const selects = !e[forceKey];
        Object.defineProperty(e, forceKey, { value: !e[forceKey] });
        const box = screenBox();
        // a plain drag in a full-screen program: past the edge Hollr scrolls it (dragMove)
        if (!selects || e.detail > 1 || x.buffer.active.type !== "alternate" || !box) return;
        const at = cellOf(e, box);
        drag = { ...at, at, speed: 0 };
        window.addEventListener("mousemove", dragMove, true);
        window.addEventListener("mouseup", dragEnd, true);
      };
      el.addEventListener("mousedown", forceSelect, { capture: true });
      // like Ghostty: letting go of a selection copies it – and offers it for reading aloud (ReadAloud.svelte)
      const copyOnSelect = (e: MouseEvent) => {
        if (e.button !== 0) return;
        setTimeout(() => {
          if (!x.hasSelection()) return;
          const text = cleanSelection(x.getSelection());
          void copyText(text);
          const buf = x.buffer.active;
          offerAt(text, e, Math.max(0, (x.getSelectionPosition()?.start.y ?? buf.viewportY) - buf.viewportY));
        }, 0);
      };
      let offers = 0;
      /** Offers a selection starting on screen row `row` for reading aloud and as a jump note – with its row in the
       *  whole scrollback, measured now: the overview's last measurement may be old, or missing when it is off. */
      function offerAt(text: string, e: MouseEvent, row: number) {
        const n = ++offers;
        // a scroll selection may lie wholly off screen (nothing highlighted) – only a highlight cleared meanwhile cancels
        const shown = x.hasSelection();
        void topLine().then((top) => {
          // a newer selection, or this one gone meanwhile
          if (n !== offers || term !== x || (shown && !x.hasSelection())) return;
          offerSelection({ text, source: "terminal", server, x: e.clientX, y: e.clientY, termRow: Math.max(0, top + row) });
        });
      }
      el.addEventListener("mouseup", copyOnSelect);
      const selectionGone = x.onSelectionChange(() => x.hasSelection() || withdrawSelection("terminal"));
      // herdr asks for every pointer motion (any-event mouse tracking), and xterm counts each motion report as
      // input – which clears its selection: a selection vanished as soon as the pointer moved after letting go.
      // While text is selected, plain motion (no button held) stays out of the program.
      const keepSelection = (e: MouseEvent) => {
        if (e.buttons === 0 && x.hasSelection() && x.modes.mouseTrackingMode === "any") e.stopPropagation();
      };
      el.addEventListener("mousemove", keepSelection, { capture: true });

      // Selecting past the top/bottom edge: herdr's attach has no scrollback in xterm, so Hollr takes the
      // drag over from xterm, scrolls the pane with the mouse wheel and collects the text (scrollSelection.ts).
      type Drag = { row: number; col: number; at: { row: number; col: number }; speed: number; sel?: ScrollSelection; timer?: ReturnType<typeof setInterval> };
      let drag: Drag | null = null;
      function screenBox() {
        return x.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
      }
      function cellOf(e: MouseEvent, box: DOMRect) {
        return {
          row: Math.floor(((e.clientY - box.top) / box.height) * x.rows),
          col: Math.min(x.cols - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * x.cols))),
        };
      }
      /** the rows on screen as cells (a wide character's second cell ""): ScrollSelection counts columns in cells */
      function screenRows() {
        const buf = x.buffer.active;
        const cell = buf.getNullCell();
        return Array.from({ length: x.rows }, (_, r) => {
          const line = buf.getLine(buf.viewportY + r);
          const cells: string[] = [];
          for (let c = 0; line && c < x.cols && line.getCell(c, cell); c++)
            cells.push(cell.getWidth() === 0 ? "" : cell.getChars() || " ");
          // the blanks a TUI pads its rows with
          while (cells.length && !cells[cells.length - 1]!.trim()) cells.pop();
          return cells;
        });
      }
      /** the part of the selection on screen */
      function highlight(d: Drag, sel: ScrollSelection) {
        const [s, e] = sel.range(sel.point(d.at.row, d.at.col, x.rows));
        let [rs, cs, re, ce] = [s.line - sel.top, s.col, e.line - sel.top, Math.min(e.col, x.cols - 1)];
        if (rs < 0) [rs, cs] = [0, 0];
        if (re >= x.rows) [re, ce] = [x.rows - 1, x.cols - 1];
        if (rs > re) x.clearSelection();
        else x.select(cs, x.buffer.active.viewportY + rs, (re - rs) * x.cols + ce - cs + 1);
      }
      function scrollTick() {
        if (!drag?.speed) return;
        // SGR mouse wheel (herdr asks for 1006) in the middle of the screen: 64 up, 65 down
        const wheel = `\x1b[<${drag.speed < 0 ? 64 : 65};${Math.ceil(x.cols / 2)};${Math.ceil(x.rows / 2)}M`;
        s.type(wheel.repeat(Math.min(3, Math.abs(drag.speed))));
      }
      let first = true;
      const parsed = x.onWriteParsed(() => {
        lastWrite = performance.now();
        dirty = true;
        // the first frame shows what the terminal is (herdr's alternate screen): the overview measured on mount saw
        // xterm's empty buffer – the next poll measures again instead of waiting out the 4 s throttle
        if (first) measuredAt = 0;
        first = false;
        framed();
        if (drag?.sel?.update(screenRows())) highlight(drag, drag.sel);
      });
      // an own shell scrolled in xterm: the overview's box moves
      const scrolled = x.onScroll(() => (dirty = true));
      function dragMove(e: MouseEvent) {
        const d = drag;
        const box = screenBox();
        if (!d || !box || !e.isTrusted) return;
        // the button was let go where no mouseup reached us (outside the window): the drag is over, the
        // scroll timer must not go on wheeling the pane
        if (!(e.buttons & 1)) return stopDrag();
        d.at = cellOf(e, box);
        const over = e.clientY < box.top ? e.clientY - box.top : e.clientY > box.bottom ? e.clientY - box.bottom : 0;
        if (!d.sel) {
          if (!over) return;
          // xterm's own drag ends here (its mouseup listener sits on the document)
          document.dispatchEvent(new MouseEvent("mouseup", { clientX: e.clientX, clientY: e.clientY, button: 0 }));
          d.sel = new ScrollSelection(screenRows(), d.row, d.col);
          d.timer = setInterval(scrollTick, 80);
        }
        d.speed = over ? Math.sign(over) * (1 + Math.floor(Math.abs(over) / 30)) : 0;
        highlight(d, d.sel);
      }
      function dragEnd(e: MouseEvent) {
        if (!e.isTrusted || e.button !== 0) return;
        const d = drag;
        stopDrag();
        if (!d?.sel) return;
        const box = screenBox();
        if (box) d.at = cellOf(e, box);
        d.sel.update(screenRows());
        highlight(d, d.sel);
        // copied here in full – copyOnSelect would take only the part on screen
        e.stopPropagation();
        const p = d.sel.point(d.at.row, d.at.col, x.rows);
        const text = cleanSelection(d.sel.text(p));
        void copyText(text);
        // the selection's first line, which may lie above the screen by now
        offerAt(text, e, d.sel.range(p)[0].line - d.sel.top);
      }
      function stopDrag() {
        clearInterval(drag?.timer);
        drag = null;
        window.removeEventListener("mousemove", dragMove, true);
        window.removeEventListener("mouseup", dragEnd, true);
      }
      const input = x.onData((data) => {
        // typing and the wheel (mouse reports) alike
        touchedAt = Date.now();
        s.type(data);
      });
      const focusIn = () => (focused = true);
      const focusOut = () => (focused = false);
      x.textarea?.addEventListener("focus", focusIn);
      x.textarea?.addEventListener("blur", focusOut);

      // sized to the panel: the first fit starts the connection
      let frame = 0;
      const refit = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (!el.offsetWidth || !el.offsetHeight) return;
          fit.fit();
          s.resize(x.cols, x.rows);
        });
      };
      const ro = new ResizeObserver(refit);
      ro.observe(el);
      refit();

      return () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        el.removeEventListener("mousedown", forceSelect, { capture: true });
        el.removeEventListener("mouseup", copyOnSelect);
        el.removeEventListener("mousemove", keepSelection, { capture: true });
        stopDrag();
        parsed.dispose();
        scrolled.dispose();
        selectionGone.dispose();
        withdrawSelection("terminal");
        clearTimeout(copiedTimer);
        input.dispose();
        x.textarea?.removeEventListener("focus", focusIn);
        x.textarea?.removeEventListener("blur", focusOut);
        s.dispose();
        x.dispose();
        if (term === x) term = undefined;
        if (session === s) session = undefined;
      };
    });
  });

  // back in front: a dropped connection retries right away instead of after its pause
  function onVisible() {
    if (document.visibilityState === "visible") session?.reconnectNow();
  }

  /** Herdr key names (the composer's key menu) into the terminal. */
  export function send(keys: string[]) {
    const appCursor = term?.modes.applicationCursorKeysMode ?? false;
    session?.type(keys.map((k) => keySequence(k, appCursor) ?? "").join(""));
    term?.focus();
  }
  export const focus = () => term?.focus();

  // The overview at the right edge: the whole scrollback in miniature (line lengths in their first colour), the
  // visible part as a box, jump notes as bands. A herdr session is a full-screen TUI without scrollback in xterm –
  // its scrollback lives in herdr (`scrollmap`, moved with mouse-wheel events); an own shell has it in xterm.
  type MiniLine = [number, string | null];
  type Mini = { total: number; top: number; rows: number; lines: MiniLine[] };
  type Position = { total: number; top: number; rows: number };
  let mini = $state.raw<Mini | null>(null);
  /** the screen changed (output, xterm scrolled) since the overview was last measured */
  let dirty = true;
  let measuredAt = 0;
  /** the newest herdr measurement: an older answer arriving later must not undo it */
  let mapSeq = 0;
  let mapping = false;
  /** the server's Hollr has no `scrollmap` (older than the overview): stop asking */
  let noMap = false;
  /** the first output of the current terminal is on screen (before it, xterm's buffer says nothing about herdr) */
  let ready = new Promise<void>(() => {});
  /** when output was last parsed (performance.now) */
  let lastWrite = 0;
  /** when the user last typed or scrolled in the terminal (Date.now) */
  let touchedAt = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const inHerdr = () => !!term && term.buffer.active.type === "alternate";
  const PALETTE = ["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
    "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea"];

  async function measureMini() {
    const x = term;
    if (!x) return;
    dirty = false;
    measuredAt = Date.now();
    if (inHerdr()) {
      const seq = ++mapSeq;
      mapping = true;
      try {
        const r = await gate<{ total: number; offset: number; rows: number; lines: MiniLine[] }>(srv, `scrollmap ${paneId}`);
        if (seq === mapSeq && term === x)
          mini = { total: r.total, top: Math.max(0, r.total - r.rows - r.offset), rows: r.rows, lines: r.lines };
      } catch (e) {
        // a failed poll keeps the last map (the next one is due in 10 s at the latest); an old server never answers
        if (seq === mapSeq && term === x && e instanceof Error && e.message === "not_allowed") {
          noMap = true;
          mini = null;
        }
      } finally {
        if (seq === mapSeq) mapping = false;
      }
      return;
    }
    const b = x.buffer.active;
    const lines: MiniLine[] = [];
    const cell = b.getNullCell();
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y);
      if (!line) { lines.push([0, null]); continue; }
      const text = line.translateToString(true);
      let color: string | null = null;
      const first = text.search(/\S/);
      if (first >= 0 && line.getCell(first, cell)) {
        if (cell.isFgRGB()) color = `#${cell.getFgColor().toString(16).padStart(6, "0")}`;
        else if (cell.isFgPalette()) color = PALETTE[cell.getFgColor()] ?? null;
      }
      lines.push([text.length, color]);
    }
    mini = { total: b.length, top: b.viewportY, rows: x.rows, lines };
  }
  $effect(() => {
    if (!overview) return;
    // untracked: measuring writes `mini` (and for an own shell reads it right away), which made this effect depend
    // on what it writes – an endless loop (effect_update_depth_exceeded) as soon as a terminal opened
    untrack(() => void measureMini());
    // only when something changed (herdr redraws on new lines and on scrolling), not every 1.2 s for hours: a working
    // agent redraws all the time (spinner), so without the user's hand on it every 4 s is enough; every 10 s
    // regardless (herdr adds lines without a redraw while scrolled up). An own shell is measured here, without a
    // server call: right away.
    const id = setInterval(() => {
      if (document.hidden || noMap || mapping || phase.kind !== "open") return;
      const age = Date.now() - measuredAt;
      if ((dirty && (!inHerdr() || Date.now() - touchedAt < 5000 || age > 4000)) || age > 10_000) void measureMini();
    }, 1200);
    return () => clearInterval(id);
  });

  /** where the screen is in the whole scrollback: herdr's scroll position (`scrollinfo`, no line data) or xterm's */
  async function position(): Promise<Position | null> {
    const x = term;
    if (!x) return null;
    if (!inHerdr()) {
      const b = x.buffer.active;
      return { total: b.length, top: b.viewportY, rows: x.rows };
    }
    try {
      const r = await gate<{ max: number; offset: number; rows: number }>(srv, `scrollinfo ${paneId}`);
      return term === x ? { total: r.max + r.rows, top: Math.max(0, r.max - r.offset), rows: r.rows } : null;
    } catch {
      return null;
    }
  }

  /** The first line on screen, counted from the top of the whole scrollback – measured now: the overview's last
   *  measurement may be old, or missing when the overview is off (a jump note made then landed on line 0). */
  export async function topLine(): Promise<number> {
    return (await position())?.top ?? mini?.top ?? 0;
  }

  /** After wheel events: until herdr has redrawn (its output went quiet) – at most 1.5 s. */
  async function settled(since: number) {
    while (performance.now() < since + 1500) {
      await sleep(60);
      if (lastWrite > since && performance.now() - lastWrite >= 120) return;
    }
  }

  let wanted = 0;
  let scrolling = false;
  /** herdr's lines per wheel step: not known here, learnt from what each round moved */
  let perStep = 3;
  /** Scrolls so that `line` (from the top of the scrollback) is the first one on screen. */
  export async function scrollToTop(line: number) {
    // a drag asks many times a second: one loop chases the newest target
    wanted = line;
    if (scrolling) return;
    scrolling = true;
    try {
      // just switched to the terminal (a jump note from the chat): only its first frame tells herdr from a shell
      await Promise.race([ready, sleep(15_000)]);
      const x = term;
      const s = session;
      if (!x || !s) return;
      if (!inHerdr()) {
        x.scrollToLine(Math.max(0, Math.round(wanted)));
        return;
      }
      // without mouse reporting the wheel sequences would land as text in the program's input
      if (x.modes.mouseTrackingMode === "none") return;
      let cur = await position();
      for (let round = 0; cur && round < 12 && term === x; round++) {
        const want = Math.max(0, Math.min(cur.total - cur.rows, Math.round(wanted)));
        const delta = cur.top - want;
        if (Math.abs(delta) < 2) break;
        const steps = Math.min(400, Math.max(1, Math.round(Math.abs(delta) / perStep)));
        const since = performance.now();
        s.type(`\x1b[<${delta > 0 ? 64 : 65};${Math.ceil(x.cols / 2)};${Math.ceil(x.rows / 2)}M`.repeat(steps));
        await settled(since);
        const next = await position();
        if (!next || term !== x) break;
        const moved = Math.abs(next.top - cur.top);
        // nothing moved: the wheel doesn't reach herdr's scrollback – stop instead of flooding the program with it
        if (!moved) break;
        perStep = Math.min(50, Math.max(0.5, moved / steps));
        // the box follows while dragging; a map measured before this round is out of date
        if (mini) {
          mapSeq++;
          mapping = false;
          mini = { ...mini, top: next.top, rows: next.rows };
        }
        cur = next;
      }
    } finally {
      scrolling = false;
      if (overview) void measureMini();
    }
  }
</script>

<svelte:window onfocus={onVisible} />
<svelte:document onvisibilitychange={onVisible} />

<div class="term" class:focused>
  <div class="screen" class:ruled={overview}>
    <div class="xterm-host" bind:this={host}></div>
    {#if overview}
      <TermMinimap {mini} {notes} onScroll={(line) => void scrollToTop(line)} onNote={(n) => void scrollToTop((n.termRow ?? 0) - 3)} {onNoteMenu} />
    {/if}
    {#if copied}
      {#key copied}<div class="toast" role="status"><Icon name="✓" size={15} /> {t("Auswahl kopiert")}</div>{/key}
    {/if}
    {#if phase.kind === "connecting"}
      <div class="center"><span class="spin"></span>{t("Verbinde …")}</div>
    {:else if phase.kind === "reconnecting"}
      <div class="pill"><Icon name="↻" size={15} /> {t("Verbinde neu …")}</div>
    {:else if phase.kind === "closed"}
      <div class="center">
        <div class="closed">
          <div>{closedText(phase.end)}</div>
          <button class="btn primary" onclick={() => { session?.restart(); term?.focus(); }}>{t("Neu verbinden")}</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .term { display: flex; flex-direction: column; min-height: 0; height: 100%; border: 1px solid var(--border); border-radius: 12px;
    background: #0f1216; overflow: hidden; transition: border-color 0.15s; }
  .term.focused { border-color: color-mix(in srgb, var(--accent) 70%, transparent); }
  .screen { position: relative; flex: 1; min-height: 0; }
  .xterm-host { position: absolute; inset: 6px 4px 4px 10px; }
  .screen.ruled .xterm-host { right: 64px; }
  .xterm-host :global(.xterm) { height: 100%; }
  .center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px;
    color: rgba(255, 255, 255, 0.8); font-size: 13px; pointer-events: none; }
  .closed { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 14px 18px; border-radius: 14px;
    background: rgba(0, 0, 0, 0.6); pointer-events: auto; max-width: 80%; text-align: center; }
  .pill { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); padding: 5px 11px; border-radius: 999px;
    font-size: 12px; color: #fff; background: rgba(40, 44, 52, 0.75); backdrop-filter: blur(8px); pointer-events: none; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.25); border-top-color: #fff;
    animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px;
    font-size: 12px; color: #fff; background: rgba(40, 44, 52, 0.85); backdrop-filter: blur(8px); pointer-events: none;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); animation: toast 1.4s ease forwards; }
  @keyframes toast { 0% { opacity: 0; transform: translate(-50%, 6px); } 12%, 75% { opacity: 1; transform: translate(-50%, 0); }
    100% { opacity: 0; } }
</style>
