<script lang="ts">
  // A real terminal on the pane (xterm.js, like iOS TerminalView): "Session" streams the pane's own
  // TUI sized to this panel (`hollr gate attach`), "Eigene Shell" an own shell in its folder
  // (`hollr gate shell`). Click into it and type: keys go straight in, Cmd shortcuts stay with the app.
  // A dropped connection comes back by itself; Cmd+click opens links.
  import { untrack } from "svelte";
  import { Terminal, type IBufferCell, type ILink } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { t } from "../i18n";
  import { settings } from "../settings.svelte";
  import { findLinks, keySequence, TermSession, type TermEnd, type TermMode, type TermPhase } from "../terminal";

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

  /** Links in the (wrapped) line at buffer row `y` (1-based), mapped back to their cells. */
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
    return findLinks(text)
      .map((l) => ({ start: cells[l.start], end: cells[l.end - 1], url: l.url }))
      .filter((l) => l.start && l.end && l.start.y <= y && l.end.y >= y)
      .map((l) => ({
        range: { start: l.start, end: l.end },
        text: l.url,
        activate: (e: MouseEvent) => {
          openLink(e, l.url);
        },
      }));
  }

  // primitives that only change when they really do: the parent hands `pane` through an object that
  // is new on every poll, which would otherwise restart the terminal each time
  const srv = $derived(server);
  const paneId = $derived(pane);
  const mode = $derived<TermMode>(settings.terminalMode === "shell" ? "shell" : "pane");

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
        // Option+drag selects even when the TUI takes the mouse; Option stays for typing @ [ ] { } on a Mac
        macOptionClickForcesSelection: true,
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
        const copy = mac ? e.metaKey && key === "c" : e.ctrlKey && key === "c" && x.hasSelection();
        if (copy) {
          if (x.hasSelection()) navigator.clipboard.writeText(x.getSelection()).catch(() => {});
          return false;
        }
        // Cmd shortcuts stay with the app (Cmd+V arrives as a paste, which xterm types in)
        if (e.metaKey) return false;
        // Windows/Linux: Ctrl+V pastes
        if (!mac && e.ctrlKey && key === "v") return false;
        return true;
      });
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
      <button role="tab" aria-selected={mode === "pane"} class:on={mode === "pane"} onclick={() => (settings.terminalMode = "pane")}>{t("Session")}</button>
      <button role="tab" aria-selected={mode === "shell"} class:on={mode === "shell"} onclick={() => (settings.terminalMode = "shell")}>{t("Eigene Shell")}</button>
    </div>
    <span class="grow">{focused ? t("Tippen geht direkt ans Terminal – Esc, Pfeile und Ctrl-Tasten inklusive") : t("Ins Terminal klicken, um direkt zu tippen")}</span>
    <span class="hint" title={t("⌥ gedrückt halten, um in Vollbild-Programmen Text zu markieren")}>{mac ? t("⌘-Klick öffnet Links") : t("Strg-Klick öffnet Links")}</span>
  </div>
  <div class="screen">
    <div class="xterm-host" bind:this={host}></div>
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
</style>
