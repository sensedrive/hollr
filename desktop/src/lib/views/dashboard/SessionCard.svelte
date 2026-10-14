<script lang="ts">
  // Dashboard card with a tiny live preview of the pane's terminal screen.
  import * as api from "$lib/api";
  import { statusLabel, t } from "$lib/i18n";
  import type { PaneRef } from "$lib/store.svelte";
  import { agentName, cleanScreen, refTitle, statusColor } from "./util";

  let { ref, onOpen, onMenu, onHide, onEnd }: {
    ref: PaneRef; onOpen: () => void; onMenu: (e: MouseEvent) => void; onHide: () => void; onEnd: () => void;
  } = $props();

  let preview = $state("");
  const working = $derived(ref.pane.status === "working");

  // poll the screen: every 4 s while working, otherwise every 15 s
  $effect(() => {
    const server = ref.server.id;
    const pane = ref.pane.pane;
    const every = working ? 4000 : 15000;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const text = await api.screen(server, pane, 30);
        if (!stop) preview = cleanScreen(text).split("\n").slice(-16).join("\n");
      } catch {}
      if (!stop) timer = setTimeout(tick, every);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  });

  const title = $derived(refTitle(ref));
  const status = $derived(ref.pane.agent ? statusLabel(ref.pane.status) : t("Terminal"));
</script>

<div class="card-wrap">
  <button class="session" data-nav class:blocked={ref.pane.status === "blocked"} onclick={onOpen}
    oncontextmenu={(e) => { e.preventDefault(); onMenu(e); }}>
    <div class="screen">
      {#if !preview}
        <div class="bars">{#each [90, 120, 70, 110, 60, 100, 80] as w}<div class="skeleton" style="width:{w}px"></div>{/each}</div>
      {:else}
        <pre>{preview}</pre>
      {/if}
      <span class="chip"><span class="dot" style="background:{statusColor(ref.pane.status)}"></span>{agentName(ref.pane)}
        {#if ref.pane.live}<span class="wave">〰</span>{/if}</span>
    </div>
    <div class="name ellipsis">{title}</div>
    <div class="meta ellipsis" style="color:{statusColor(ref.pane.status)}">{title === ref.workspace.label ? status : `${ref.workspace.label} · ${status}`}</div>
  </button>
  <div class="actions">
    <button title={t("Aus der Übersicht nehmen")} aria-label={t("Aus der Übersicht nehmen")} onclick={onHide}>◌</button>
    <button class="end" title={t("Sitzung beenden")} aria-label={t("Sitzung beenden")} onclick={onEnd}>✕</button>
  </div>
</div>

<style>
  .card-wrap { position: relative; min-width: 0; }
  .session { all: unset; box-sizing: border-box; display: grid; gap: 6px; width: 100%; cursor: pointer; padding: 6px; margin: -6px; border-radius: 16px;
    transition: background .12s; }
  .session:hover { background: color-mix(in srgb, var(--fg) 4%, transparent); }
  .session:focus-visible { outline: 2px solid var(--accent); }
  .screen { position: relative; height: 160px; border-radius: 12px; overflow: hidden; border: 1px solid var(--border);
    background: color-mix(in srgb, var(--green) 5%, var(--raised)); transition: border-color .12s, transform .12s; }
  .session:hover .screen { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
  .blocked .screen { border: 1.5px solid var(--orange); }
  pre { position: absolute; inset: 0; margin: 0; padding: 8px 10px; display: flex; flex-direction: column; justify-content: flex-end;
    font: 9px/1.3 var(--mono); color: var(--muted); white-space: pre; overflow: hidden; }
  .bars { position: absolute; inset: 0; padding: 12px; display: flex; flex-direction: column; justify-content: flex-end; gap: 7px; }
  .bars .skeleton { height: 6px; border-radius: 3px; }
  .chip { position: absolute; top: 8px; left: 8px; display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 99px;
    font-size: 11px; font-weight: 700; background: color-mix(in srgb, var(--side) 85%, transparent); backdrop-filter: blur(8px); }
  .dot { width: 7px; height: 7px; border-radius: 50%; }
  .wave { color: var(--green); }
  .name { font-weight: 600; padding: 0 2px; }
  .meta { font-size: 12px; padding: 0 2px; margin-top: -4px; }
  .actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; opacity: 0; transition: opacity .12s; }
  .card-wrap:hover .actions, .actions:focus-within { opacity: 1; }
  .actions button { all: unset; cursor: pointer; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 7px; font-size: 11px;
    background: color-mix(in srgb, var(--side) 90%, transparent); border: 1px solid var(--border); color: var(--muted); }
  .actions button:hover { color: var(--fg); border-color: var(--accent); }
  .actions .end:hover { color: var(--red); border-color: var(--red); }
</style>
