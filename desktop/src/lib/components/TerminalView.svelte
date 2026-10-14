<script lang="ts">
  // The pane's terminal screen, refreshed every 700 ms while visible. Click into it and type:
  // keystrokes go straight to the pane (herdr send-keys), paste too. Cmd shortcuts stay with the app.
  import { onDestroy } from "svelte";
  import * as api from "../api";
  import { t } from "../i18n";
  import { herdrKey, terminalScreen, textKeys } from "../agent";

  let { server, pane, active = true, onError }: {
    server: string; pane: string; active?: boolean; onError?: (message: string) => void;
  } = $props();

  let text = $state("");
  let loaded = $state(false);
  let failed = $state("");
  let focused = $state(false);
  let scroller: HTMLDivElement | undefined = $state();
  let stick = true;
  let busy = false;

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const fresh = terminalScreen(await api.screen(server, pane, 200));
      if (fresh !== text) {
        text = fresh;
        if (stick) queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
      }
      failed = "";
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    } finally {
      loaded = true;
      busy = false;
    }
  }

  export const refresh = () => setTimeout(load, 120);

  let timer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    void pane;
    if (!active) return;
    load();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 700);
    return () => clearInterval(timer);
  });
  onDestroy(() => clearInterval(timer));

  // ---- typing: keys are queued and sent in order, ≤ 10 per call (the gate's limit)
  let queue: string[] = [];
  let sending = false;
  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, 10);
        await api.keys(server, pane, batch);
      }
    } catch (e) {
      queue = [];
      const msg = e instanceof Error ? e.message : String(e);
      onError?.(t("Tasten senden fehlgeschlagen: {e}", { e: msg }));
    } finally {
      sending = false;
      load();
    }
  }
  export function send(keys: string[]) {
    queue.push(...keys);
    stick = true;
    pump();
  }

  function onKey(e: KeyboardEvent) {
    // Cmd+C copies the selection, Cmd+V pastes (handled in onPaste), other Cmd shortcuts go to the app
    if (e.metaKey) return;
    // Ctrl+C with a selection on Windows/Linux: copy instead of interrupting
    if (e.ctrlKey && e.key.toLowerCase() === "c" && window.getSelection()?.toString() && !navigator.platform.includes("Mac")) return;
    if (e.ctrlKey && e.key.toLowerCase() === "v" && !navigator.platform.includes("Mac")) return;
    const k = herdrKey(e);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    send([k]);
  }

  function onPaste(e: ClipboardEvent) {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (!pasted) return;
    e.preventDefault();
    send(textKeys(pasted.slice(0, 2000)));
  }

  function onScroll() {
    if (scroller) stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  }
</script>

<div class="term" class:focused>
  <div class="bar">
    <span class="mono">&gt;_</span>
    <span class="grow">{focused ? t("Tippen geht direkt ans Terminal – Esc, Pfeile und Ctrl-Tasten inklusive") : t("Ins Terminal klicken, um direkt zu tippen")}</span>
    {#if failed}<span class="err ellipsis" title={failed}>{failed}</span>{/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="screen" role="textbox" aria-label={t("Terminal")} aria-multiline="true" tabindex="0" bind:this={scroller}
    onkeydown={onKey} onpaste={onPaste} onfocus={() => (focused = true)} onblur={() => (focused = false)} onscroll={onScroll}>
    {#if !loaded}
      <div class="sk">{#each [70, 45, 85, 30, 60, 50] as w}<div class="skeleton" style:width="{w}%"></div>{/each}</div>
    {:else}
      <pre>{text}</pre>
    {/if}
  </div>
</div>

<style>
  .term { display: flex; flex-direction: column; min-height: 0; height: 100%; border: 1px solid var(--border); border-radius: 12px;
    background: var(--raised); overflow: hidden; transition: border-color 0.15s; }
  .term.focused { border-color: color-mix(in srgb, var(--accent) 70%, transparent); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 11.5px; color: var(--muted);
    border-bottom: 1px solid var(--border); min-width: 0; }
  .grow { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mono { font-family: var(--mono); font-weight: 600; }
  .err { color: var(--red); max-width: 40%; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .screen { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; outline: none; cursor: text; }
  pre { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.38; white-space: pre; user-select: text; color: var(--fg); }
  .sk { display: flex; flex-direction: column; gap: 8px; }
  .sk .skeleton { height: 12px; }
</style>
