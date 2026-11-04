<script lang="ts">
  // Read aloud, app-wide (mounted once in +page.svelte): next to text selected in a chat or in the terminal
  // (TerminalView offers its xterm selection) a small group – "Vorlesen" (⌘⇧S) reads the selection,
  // "Zusammenfassung" (⌘⌥⇧S) has the server's omp summarize it first – and while it works a pill with a
  // stop button (Esc stops too); after a summary the pill offers the original for a few seconds. The chat's
  // own components stay untouched: its selection is read from the document, its server from the route.
  // ⌘⇧Y would be the obvious key, but macOS' "Make Sticky" service owns it (⌘⇧L/A/F/M/B too); the app's
  // own ⌘⇧ keys are F G B I M T, ⌘⇧Z is redo – ⌘⌥⇧S is free in the app and in macOS.
  import { t } from "$lib/i18n";
  import {
    LANG_NAMES, offerSelection, PHONON_MODELS, selection, shortModel, speaker, speech, withdrawSelection,
  } from "$lib/speech.svelte";
  import { nav } from "$lib/store.svelte";

  /** the chat transcript (TimelineView) */
  const CHAT = ".tl";
  const mac = navigator.platform.includes("Mac");
  const shortcut = mac ? "⌘⇧S" : "Ctrl+Shift+S";
  const summaryShortcut = mac ? "⌘⌥⇧S" : "Ctrl+Alt+Shift+S";

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
    const text = current()?.text;
    if (text) void speaker.speak(text);
  }

  function summarize() {
    const offer = current();
    if (offer) void speaker.summarize(offer.text, offer.server);
  }

  function onKey(e: KeyboardEvent) {
    // capture phase: while it speaks, Esc means "stop" – not zen mode, not the TUI in the terminal
    if (e.key === "Escape" && speaker.busy) {
      e.preventDefault();
      e.stopPropagation();
      speaker.stop();
    } else if ((mac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === "KeyS") {
      e.preventDefault();
      e.stopPropagation();
      if (speaker.busy) speaker.stop();
      else if (e.altKey) summarize();
      else read();
    }
  }

  /** the button next to the selection end, inside the window */
  const place = $derived.by(() => {
    const o = selection.offer;
    if (!o) return null;
    const below = o.y + 40 < innerHeight;
    return { left: Math.max(8, Math.min(o.x - 20, innerWidth - 270)), top: below ? o.y + 6 : Math.max(8, o.y - 40) };
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

{#if speaker.busy}
  <div class="pill" role="status">
    <span class="bars" class:on={speaker.state === "speaking"} class:wait={speaker.state === "summarizing"} aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="grow">
      {#if speaker.state === "summarizing"}
        {t("Fasse zusammen …")}
        <span class="muted">· {speaker.summaryModel ? shortModel(speaker.summaryModel) : t("schnelles Modell")}</span>
      {:else}
        {speaker.state === "loading" ? t("Stimme startet …") : speaker.summaryFor ? t("Liest die Zusammenfassung") : t("Liest vor")}
        <span class="muted">· {t(LANG_NAMES[speaker.lang])}{engineLabel ? ` · ${engineLabel}` : ""}</span>
      {/if}
    </span>
    <button class="stop" title={t("Vorlesen stoppen (Esc)")} aria-label={t("Vorlesen stoppen (Esc)")} onclick={() => speaker.stop()}>
      <span class="sq"></span>
    </button>
  </div>
{:else if speaker.notice}
  <div class="pill note" class:warn={speaker.failed} role="status">{speaker.notice}</div>
{:else if speaker.original}
  <div class="pill" role="status">
    <span class="grow muted">{t("Zusammenfassung gelesen")}</span>
    <button class="again" onclick={() => speaker.readOriginal()}>{t("Original vorlesen")}</button>
    <button class="close" title={t("Schließen")} aria-label={t("Schließen")} onclick={() => (speaker.original = null)}>✕</button>
  </div>
{/if}

<style>
  .offer { position: fixed; z-index: 60; display: flex; align-items: center; border-radius: 99px; font-size: 12px;
    background: var(--raised, var(--card)); color: var(--fg); border: 1px solid var(--border); box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
  .offer button { all: unset; display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 4px 10px; border-radius: 99px; }
  .offer button:hover { color: var(--accent); }
  .offer .sep { width: 1px; align-self: stretch; margin: 5px 0; background: var(--border); }
  .pill { position: fixed; z-index: 60; left: 50%; top: 12px; transform: translateX(-50%); display: flex; align-items: center;
    gap: 10px; max-width: min(520px, 80vw); padding: 5px 6px 5px 14px; border-radius: 99px; font-size: 12.5px;
    background: var(--raised, var(--card)); border: 1px solid var(--border); box-shadow: 0 6px 20px rgba(0, 0, 0, .3); }
  .pill .grow { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill.note { padding: 7px 14px; white-space: normal; }
  .pill.warn { color: var(--red); }
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
  .again { all: unset; cursor: pointer; flex: none; padding: 3px 10px; border-radius: 99px; font-size: 12px; color: var(--fg);
    background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .again:hover { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .close { all: unset; cursor: pointer; flex: none; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%;
    color: var(--muted); font-size: 11px; }
  .close:hover { color: var(--fg); }
  .stop { all: unset; cursor: pointer; flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    background: var(--red); }
  .stop:hover { filter: brightness(1.1); }
  .sq { width: 9px; height: 9px; border-radius: 2px; background: #fff; }
</style>
