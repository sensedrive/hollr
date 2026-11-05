<script lang="ts">
  // A real terminal on the pane (xterm.js, like iOS TerminalView): "Session" streams the pane's own
  // TUI sized to this panel (`hollr gate attach`), "Eigene Shell" an own shell in its folder
  // (`hollr gate shell`). Click into it and type: keys go straight in, Cmd shortcuts stay with the app.
  // A dropped connection comes back by itself; Cmd+click opens links and file paths (the preview).
  import { untrack } from "svelte";
  import { Terminal, type IBufferCell, type ILink } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { t } from "../i18n";
  import { settings } from "../settings.svelte";
  import { findLinks, keySequence, TermSession, type TermEnd, type TermMode, type TermPhase } from "../terminal";
  import { findPaths, pathHref } from "../paths";
  import { rememberViewPrefs, viewPrefsOf } from "../viewPrefs";
  import { cleanSelection, ScrollSelection } from "../scrollSelection";
  import { offerSelection, withdrawSelection } from "../speech.svelte";

  let { server, pane, onLink }: {
    server: string; pane: string; onLink?: (href: string) => void;
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
      case "exit": return t("Shell beendet.");
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
  function linksAt(y: number): ILink[] {
    if (!term) return [];
    const buf = term.buffer.active;
    let first = y - 1;
    while (first > 0 && buf.getLine(first)?.isWrapped) first--;
    let text = "";
    const cells: { x: number; y: number }[] = [];
    let cell: IBufferCell | undefined;
    for (let row = first; row < buf.length; row++) {
      const line = buf.getLine(row);
      if (!line || (row > first && !line.isWrapped)) break;
      for (let x = 0; x < line.length; x++) {
        cell = line.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue; // the second half of a wide character
        const chars = cell.getChars() || " ";
        text += chars;
        for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1 });
      }
    }
    const found = [
      ...findLinks(text),
      ...findPaths(text).map((p) => ({ start: p.start, end: p.end, url: pathHref(p.path, p.line) })),
    ];
    return found
      .map((l) => ({ start: cells[l.start], end: cells[l.end - 1], url: l.url, label: text.slice(l.start, l.end) }))
      .filter((l) => l.start && l.end && l.start.y <= y && l.end.y >= y)
      .map((l) => ({
        range: { start: l.start, end: l.end },
        text: l.label,
        activate: (e: MouseEvent) => {
          openLink(e, l.url);
        },
      }));
  }

  // primitives that only change when they really do: the parent hands `pane` through an object that
  // is new on every poll, which would otherwise restart the terminal each time
  const srv = $derived(server);
  const paneId = $derived(pane);
  // "Session" or "Eigene Shell" as last left in this session; a session never set uses the last choice made
  let mode = $state<TermMode>(untrack(() => viewPrefsOf(`${server}|${pane}`).term ?? (settings.terminalMode === "shell" ? "shell" : "pane")));
  function setMode(m: TermMode) {
    mode = m;
    settings.terminalMode = m;
    rememberViewPrefs(`${srv}|${paneId}`, { term: m });
  }

  $effect(() => {
    const el = host;
    const target = { server: srv, pane: paneId, mode };
    if (!el) return;
    return untrack(() => {
      phase = { kind: "connecting" };
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
        // OSC 8 hyperlinks
        linkHandler: {
          activate: (e, uri) => {
            openLink(e, uri);
          },
        },
      });
      const fit = new FitAddon();
      x.loadAddon(fit);
      x.open(el);
      term = x;
      const s = new TermSession({
        ...target,
        onOutput: (data) => x.write(data),
        onPhase: (ph) => (phase = ph),
      });
      session = s;

      x.registerLinkProvider({ provideLinks: (y, done) => done(linksAt(y)) });
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
          offerSelection({ text, source: "terminal", server, x: e.clientX, y: e.clientY });
        }, 0);
      };
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
      function screenRows() {
        const buf = x.buffer.active;
        return Array.from({ length: x.rows }, (_, r) => buf.getLine(buf.viewportY + r)?.translateToString(true) ?? "");
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
      const parsed = x.onWriteParsed(() => {
        if (drag?.sel?.update(screenRows())) highlight(drag, drag.sel);
      });
      function dragMove(e: MouseEvent) {
        const d = drag;
        const box = screenBox();
        if (!d || !box || !e.isTrusted) return;
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
        const text = cleanSelection(d.sel.text(d.sel.point(d.at.row, d.at.col, x.rows)));
        void copyText(text);
        offerSelection({ text, source: "terminal", server, x: e.clientX, y: e.clientY });
      }
      function stopDrag() {
        clearInterval(drag?.timer);
        drag = null;
        window.removeEventListener("mousemove", dragMove, true);
        window.removeEventListener("mouseup", dragEnd, true);
      }
      const input = x.onData((data) => s.type(data));
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
</script>

<svelte:window onfocus={onVisible} />
<svelte:document onvisibilitychange={onVisible} />

<div class="term" class:focused>
  <div class="bar">
    <span class="mono">&gt;_</span>
    <div class="seg" role="tablist" aria-label={t("Terminal")}>
      <button role="tab" aria-selected={mode === "pane"} class:on={mode === "pane"} onclick={() => setMode("pane")}>{t("Session")}</button>
      <button role="tab" aria-selected={mode === "shell"} class:on={mode === "shell"} onclick={() => setMode("shell")}>{t("Eigene Shell")}</button>
    </div>
    <span class="grow">{focused ? t("Tippen geht direkt ans Terminal – Esc, Pfeile und Ctrl-Tasten inklusive") : t("Ins Terminal klicken, um direkt zu tippen")}</span>
    <span class="hint" title={mac ? t("Markieren kopiert sofort · ⌥-Klick geht an das Programm im Terminal") : t("Markieren kopiert sofort · ⇧-Klick geht an das Programm im Terminal")}>{mac ? t("⌘-Klick öffnet Links und Dateien") : t("Strg-Klick öffnet Links und Dateien")}</span>
  </div>
  <div class="screen">
    <div class="xterm-host" bind:this={host}></div>
    {#if copied}
      {#key copied}<div class="toast" role="status">✓ {t("Auswahl kopiert")}</div>{/key}
    {/if}
    {#if phase.kind === "connecting"}
      <div class="center"><span class="spin"></span>{t("Verbinde …")}</div>
    {:else if phase.kind === "reconnecting"}
      <div class="pill">↻ {t("Verbinde neu …")}</div>
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
  .bar { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 11.5px; color: var(--muted);
    border-bottom: 1px solid var(--border); min-width: 0; background: var(--raised); }
  .grow { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { white-space: nowrap; flex-shrink: 0; }
  .mono { font-family: var(--mono); font-weight: 600; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; flex-shrink: 0; }
  .seg button { border: 0; background: transparent; color: var(--muted); font: inherit; padding: 2px 9px; cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button.on { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--fg); }
  .screen { position: relative; flex: 1; min-height: 0; }
  .xterm-host { position: absolute; inset: 6px 4px 4px 10px; }
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
