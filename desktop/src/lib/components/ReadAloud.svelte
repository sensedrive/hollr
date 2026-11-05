<script lang="ts">
  import { sidechats } from "$lib/sidechats.svelte";
  import Icon from "$lib/components/git/Icon.svelte";
  // Read aloud, app-wide (mounted once in +page.svelte): next to text selected in a chat or in the terminal
  // (TerminalView offers its xterm selection) a small group – "Vorlesen" (⌘⇧S) reads the selection,
  // "Zusammenfassung" (⌘⌥⇧S) has the server's omp summarize it first. What is read shows in a panel at the
  // top – the summary (and its model) or the cleaned-up original, selectable – with stop, replay, the speed
  // and a way to the settings; it stays after reading until closed (Esc stops, a second Esc closes). The
  // chat's own components stay untouched: its selection is read from the document, its server from the route.
  // ⌘⇧Y would be the obvious key, but macOS' "Make Sticky" service owns it (⌘⇧L/A/F/M/B too); the app's
  // own ⌘⇧ keys are F G B I M T, ⌘⇧Z is redo – ⌘⌥⇧S is free in the app and in macOS.
  import { t } from "$lib/i18n";
  import {
    LANG_NAMES, offerSelection, PHONON_MODELS, selection, shortModel, SPEED, speaker, speech, withdrawSelection,
  } from "$lib/speech.svelte";
  import { speakable } from "$lib/speechText";
  import { go, nav } from "$lib/store.svelte";

  /** the chat transcript (TimelineView) */
  const CHAT = ".tl";
  const mac = navigator.platform.includes("Mac");
  const shortcut = mac ? "⌘⇧S" : "Ctrl+Shift+S";
  const summaryShortcut = mac ? "⌘⌥⇧S" : "Ctrl+Alt+Shift+S";
  const askShortcut = mac ? "⌘⇧K" : "Ctrl+Shift+K";

  /** The rendered text of a chat selection. In a selection with prose, code blocks (and the code of tool
   *  cards) are left out; a selection of only code is read as it is. */
  function selectedText(range: Range): string {
    const start = range.commonAncestorContainer;
    if ((start instanceof Element ? start : start.parentElement)?.closest("pre")) return range.toString();
    // innerText needs layout: an invisible copy in the document
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-99999px;top:0;width:800px;white-space:normal;";
    holder.append(range.cloneContents());
    holder.querySelectorAll("button, svg, [aria-hidden='true']").forEach((e) => e.remove());
    document.body.append(holder);
    const all = holder.innerText;
    holder.querySelectorAll("pre, .codeblock").forEach((e) => e.replaceWith(document.createElement("p")));
    const prose = holder.innerText;
    holder.remove();
    return prose.trim() ? prose : all;
  }

  /** the selection in a chat right now, with where the button goes */
  function chatSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el?.closest(CHAT) || el.closest("input, textarea, [contenteditable='true']")) return null;
    const text = selectedText(range);
    if (!text.trim()) return null;
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
    // only the agent view shows a chat: its route names the server
    const server = nav.route.view === "agent" ? nav.route.server : undefined;
    return { text, source: "chat" as const, server, x: r.right, y: r.bottom };
  }

  function checkChat() {
    const found = chatSelection();
    if (found) offerSelection(found);
    else withdrawSelection("chat");
  }

  // while the mouse drags the selection grows: the button waits for the mouseup
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function onSelectionChange() {
    if (dragging) return;
    clearTimeout(timer);
    timer = setTimeout(checkChat, 150);
  }
  function onMouseUp(e: MouseEvent) {
    if (e.button !== 0) return;
    dragging = false;
    setTimeout(checkChat, 0);
  }
  function onScroll() {
    if (selection.offer?.source === "chat") checkChat();
  }

  /** what to read: the chat's live selection, else the last one offered (the terminal's) */
  const current = () => chatSelection() ?? selection.offer;

  function read() {
    const offer = current();
    if (offer) void speaker.speak(offer.text, offer.server);
  }

  /** a chat selection in a session: it can become a sidechat ("Nachfragen") about that session */
  const canAsk = $derived(selection.offer?.source === "chat" && nav.route.view === "agent");
  function ask() {
    const offer = current();
    const r = nav.route;
    if (!offer || r.view !== "agent") return;
    sidechats.start(r.server, r.pane, offer.text);
    document.getSelection()?.removeAllRanges();
    withdrawSelection("chat");
  }

  function summarize() {
    const offer = current();
    if (offer) void speaker.summarize(offer.text, offer.server);
  }

  function onKey(e: KeyboardEvent) {
    // capture phase: while it speaks, Esc means "stop" – not zen mode, not the TUI in the terminal;
    // afterwards the next Esc closes the panel (unless a dialog is open: that Esc is the dialog's)
    if (e.key === "Escape" && (speaker.busy || (speaker.reading && !document.querySelector('[role="dialog"]')))) {
      e.preventDefault();
      e.stopPropagation();
      if (speaker.busy) speaker.stop();
      else speaker.close();
    } else if ((mac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === "KeyK" && chatSelection() && nav.route.view === "agent") {
      // ⌘⇧K with a chat selection: a sidechat about it (without one, the session toggles its panel)
      e.preventDefault();
      e.stopPropagation();
      ask();
    } else if ((mac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === "KeyS") {
      e.preventDefault();
      e.stopPropagation();
      if (speaker.busy) speaker.stop();
      else if (e.altKey) summarize();
      else read();
    }
  }

  /** the speed in 0.05 steps, inside the range (the settings slider moves in 0.05) */
  function nudgeSpeed(by: number) {
    speech.speed = Math.round(Math.min(SPEED.max, Math.max(SPEED.min, speech.speed + by)) * 20) / 20;
  }

  const reading = $derived(speaker.reading);
  /** the panel's text: the summary, or the original as the voice reads it */
  const shown = $derived(
    !reading ? "" : reading.showing === "summary" ? (reading.summary ?? "") : speakable(reading.original),
  );
  const status = $derived.by(() => {
    if (!reading) return "";
    if (speaker.state === "summarizing") return t("Fasse zusammen …");
    if (speaker.state === "loading") return t("Stimme startet …");
    const summary = reading.showing === "summary";
    if (speaker.state === "speaking") return summary ? t("Liest die Zusammenfassung") : t("Liest vor");
    return summary ? t("Zusammenfassung") : t("Original");
  });
  const detail = $derived.by(() => {
    if (!reading) return "";
    const model = reading.showing === "summary" ? shortModel(reading.model) || t("schnelles Modell") : "";
    const voice = speaker.busy && speaker.state !== "summarizing" ? [t(LANG_NAMES[speaker.lang]), engineLabel] : [];
    return [model, ...voice].filter(Boolean).join(" · ");
  });
  const speedTitle = $derived(
    speaker.busy
      ? t("Tempo – gilt ab dem nächsten Vorlesen („Nochmal“ liest gleich im neuen Tempo)")
      : t("Tempo – Phonon liest etwa zwischen 0,8× und 1,3×, die Systemstimme im ganzen Bereich"),
  );

  /** the button next to the selection end, inside the window */
  const place = $derived.by(() => {
    const o = selection.offer;
    if (!o) return null;
    const below = o.y + 40 < innerHeight;
    return { left: Math.max(8, Math.min(o.x - 20, innerWidth - 390)), top: below ? o.y + 6 : Math.max(8, o.y - 40) };
  });
  const engineLabel = $derived.by(() => {
    const e = speaker.engine;
    if (!e) return "";
    if (e.engine === "phonon") return PHONON_MODELS.find((m) => m.id === e.label)?.name ?? e.label ?? "Phonon";
    return e.label ? `${t("Systemstimme")} · ${e.label.split(" (")[0]}` : t("Systemstimme");
  });
</script>

<!-- capture: the terminal's scroll-selection stops its mouseup from going further -->
<svelte:document onselectionchange={onSelectionChange} />
<svelte:window onkeydowncapture={onKey} onscrollcapture={onScroll} onresize={onScroll}
  onmousedowncapture={(e) => e.button === 0 && (dragging = true)} onmouseupcapture={onMouseUp} />

{#if place && speech.button && !speaker.busy}
  <!-- mousedown would drop the chat selection before the click -->
  <div class="offer" style:left="{place.left}px" style:top="{place.top}px" role="group" aria-label={t("Vorlesen")}>
    <button title={t("Markierung vorlesen ({key})", { key: shortcut })} onmousedown={(e) => e.preventDefault()} onclick={read}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 6v4h2.75L9 13V3L5.25 6z" /><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13.25 3.75a6 6 0 0 1 0 8.5" />
      </svg>
      {t("Vorlesen")}
    </button>
    {#if canAsk}
      <span class="sep" aria-hidden="true"></span>
      <button class="ask" title={t("Dazu nachfragen – kleiner Sidechat, kennt den ganzen Verlauf ({key})", { key: askShortcut })}
        onmousedown={(e) => e.preventDefault()} onclick={ask}><Icon name="message" size={13} /> {t("Nachfragen")}</button>
    {/if}
    {#if selection.offer?.server}
      <span class="sep" aria-hidden="true"></span>
      <button title={t("Zusammenfassung vorlesen ({key})", { key: summaryShortcut })} onmousedown={(e) => e.preventDefault()} onclick={summarize}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M3 4h10M3 8h7M3 12h4" />
        </svg>
        {t("Zusammenfassung")}
      </button>
    {/if}
  </div>
{/if}

{#if reading}
  <section class="panel" aria-label={t("Vorlesen")}>
    <div class="head" role="status">
      <span class="bars" class:on={speaker.state === "speaking"} class:wait={speaker.state === "summarizing" || speaker.state === "loading"} aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="grow title">{status}{#if detail}<span class="muted detail">· {detail}</span>{/if}</span>
      <span class="speed" title={speedTitle}>
        <button class="ic" aria-label={t("Langsamer")} disabled={speech.speed <= SPEED.min} onclick={() => nudgeSpeed(-SPEED.step)}>−</button>
        <span class="num">{speech.speed.toFixed(2)}×</span>
        <button class="ic" aria-label={t("Schneller")} disabled={speech.speed >= SPEED.max} onclick={() => nudgeSpeed(SPEED.step)}>+</button>
      </span>
      <button class="ic" title={t("Einstellungen › Vorlesen")} aria-label={t("Einstellungen › Vorlesen")} onclick={() => go({ view: "settings", page: "speech" })}><Icon name="⚙" size={15} /></button>
      {#if speaker.busy}
        <button class="stop" title={t("Vorlesen stoppen (Esc)")} aria-label={t("Vorlesen stoppen (Esc)")} onclick={() => speaker.stop()}>
          <span class="sq"></span>
        </button>
      {:else}
        <button class="ic" title={t("Schließen (Esc)")} aria-label={t("Schließen (Esc)")} onclick={() => speaker.close()}><Icon name="✕" size={15} /></button>
      {/if}
    </div>
    <div class="body">
      {#if speaker.state === "summarizing"}
        <p class="muted">{t("omp fasst den markierten Text zusammen …")}</p>
      {:else}
        <p class="text">{shown}</p>
      {/if}
      {#if reading.error}<p class="warn small">{reading.error}</p>{/if}
      {#if speaker.notice}<p class="small" class:warn={speaker.failed} class:muted={!speaker.failed}>{speaker.notice}</p>{/if}
    </div>
    {#if speaker.state !== "summarizing"}
      <div class="actions">
        {#if reading.showing === "summary"}
          <button class="act" onclick={() => speaker.readOriginal()}>{t("Original vorlesen")}</button>
        {:else if reading.summary || reading.server}
          <button class="act" onclick={() => speaker.readSummary()}>{t("Zusammenfassung vorlesen")}</button>
        {/if}
        <button class="act" onclick={() => speaker.again()}><Icon name="↻" size={15} /> {t("Nochmal")}</button>
      </div>
    {/if}
  </section>
{:else if speaker.notice}
  <div class="pill" class:warn={speaker.failed} role="status">{speaker.notice}</div>
{/if}

<style>
  .offer { position: fixed; z-index: 60; display: flex; align-items: center; border-radius: 99px; font-size: 12px;
    background: var(--raised, var(--card)); color: var(--fg); border: 1px solid var(--border); box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
  .offer button { all: unset; display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 4px 10px; border-radius: 99px; }
  .offer button:hover { color: var(--accent); }
  .offer .ask { color: var(--accent); }
  .offer .sep { width: 1px; align-self: stretch; margin: 5px 0; background: var(--border); }
  .panel, .pill { position: fixed; z-index: 60; left: 50%; top: 12px; transform: translateX(-50%); font-size: 12.5px;
    background: var(--raised, var(--card)); border: 1px solid var(--border); box-shadow: 0 6px 20px rgba(0, 0, 0, .3); }
  .pill { max-width: min(520px, 80vw); padding: 7px 14px; border-radius: 99px; }
  .pill.warn, .warn { color: var(--red); }
  .panel { width: min(640px, calc(100vw - 32px)); border-radius: 12px; display: flex; flex-direction: column; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 14px; }
  .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { margin-left: 5px; }
  .speed { display: flex; align-items: center; flex: none; }
  .num { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; }
  .ic { all: unset; cursor: pointer; flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px;
    color: var(--muted); font-size: 13px; }
  .ic:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
  .ic:disabled { opacity: .3; cursor: default; }
  .body { max-height: 40vh; overflow-y: auto; padding: 2px 14px 8px; border-top: 1px solid var(--border); user-select: text; cursor: text; }
  .body p { margin: 8px 0 0; }
  .text { white-space: pre-wrap; line-height: 1.5; font-size: 13px; }
  .small { font-size: 12px; }
  .actions { display: flex; gap: 6px; padding: 0 10px 10px; }
  .act { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 99px; font-size: 12px; color: var(--fg);
    background: color-mix(in srgb, var(--fg) 7%, transparent); }
  .act:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }
  .act:first-child { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .act:first-child:hover { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 12px; flex: none; }
  .bars i { width: 3px; height: 4px; border-radius: 1px; background: var(--accent); }
  .bars.on i { animation: bar .9s ease-in-out infinite; }
  .bars.on i:nth-child(2) { animation-delay: .15s; }
  .bars.on i:nth-child(3) { animation-delay: .3s; }
  @keyframes bar { 0%, 100% { height: 4px; } 50% { height: 12px; } }
  .bars.wait i { animation: wait 1.2s ease-in-out infinite; }
  .bars.wait i:nth-child(2) { animation-delay: .2s; }
  .bars.wait i:nth-child(3) { animation-delay: .4s; }
  @keyframes wait { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
  .stop { all: unset; cursor: pointer; flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    background: var(--red); }
  .stop:hover { filter: brightness(1.1); }
  .sq { width: 9px; height: 9px; border-radius: 2px; background: #fff; }
</style>
