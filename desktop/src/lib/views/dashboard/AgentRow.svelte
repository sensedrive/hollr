<script lang="ts">
  // One agent / terminal pane in a list: badge, workspace, tab name, what it works on, status.
  import { statusLabel, t } from "$lib/i18n";
  import { go, type PaneRef } from "$lib/store.svelte";
  import { agentName, badge, folderOf, refTitle, statusColor } from "./util";

  let { ref, showServer = false, onClose, onMenu }: {
    ref: PaneRef; showServer?: boolean; onClose?: () => void; onMenu?: (e: MouseEvent) => void;
  } = $props();

  const b = $derived(badge(ref.pane.agent));
  const title = $derived(refTitle(ref));
  const context = $derived(
    [showServer ? ref.server.label : null, title === ref.workspace.label ? null : ref.workspace.label]
      .filter(Boolean).join(" · ") || agentName(ref.pane),
  );
  const isShell = $derived(!ref.pane.agent);
</script>

<div class="wrap" class:shell={isShell}>
  <button class="item" data-nav onclick={() => go({ view: "agent", server: ref.server.id, pane: ref.pane.pane })}
    oncontextmenu={(e) => { if (onMenu) { e.preventDefault(); onMenu(e); } }}>
    <span class="badge" style="--c:{b.color}">{b.short}</span>
    <span class="grow text">
      <span class="top">
        <span class="ctx ellipsis">{context}</span>
        {#if !isShell}
          <span class="status" style="--c:{statusColor(ref.pane.status)}">{statusLabel(ref.pane.status)}</span>
        {/if}
      </span>
      <span class="title">
        <span class="ellipsis">{title}</span>
        {#if ref.pane.live}<span class="wave" title={t("Live-Sprachmodus")}>〰</span>{/if}
      </span>
      <span class="sub ellipsis">{isShell ? `Shell · ${folderOf(ref.pane.cwd)}` : `${agentName(ref.pane)} · ${ref.pane.title}`}</span>
    </span>
  </button>
  {#if onClose}
    <button class="close" title={t("Schließen")} aria-label={t("Schließen")} onclick={onClose}>✕</button>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .item { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; padding: 9px 14px; cursor: pointer; }
  .item:hover, .item:focus-visible { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .shell .item { opacity: .6; }
  .badge { flex: none; width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; font-size: 11px; font-weight: 700;
    color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
  .text { display: grid; gap: 1px; }
  .top { display: flex; align-items: center; gap: 6px; }
  .ctx { flex: 1; font-size: 12px; color: var(--muted); font-weight: 500; }
  .status { flex: none; font-size: 11px; font-weight: 600; padding: 0 8px; border-radius: 99px; color: var(--c);
    background: color-mix(in srgb, var(--c) 18%, transparent); }
  .title { display: flex; align-items: center; gap: 6px; font-weight: 600; min-width: 0; }
  .wave { color: var(--green); opacity: .7; font-size: 12px; }
  .sub { font-size: 12px; color: var(--dim); }
  .close { all: unset; position: absolute; right: 10px; top: 50%; translate: 0 -50%; width: 24px; height: 24px; display: grid; place-items: center;
    border-radius: 6px; color: var(--muted); background: var(--card); border: 1px solid var(--border); font-size: 11px; cursor: pointer; opacity: 0; }
  .wrap:hover .close, .close:focus-visible { opacity: 1; }
  .close:hover { color: var(--red); border-color: var(--red); }
  .wrap:hover .status { visibility: hidden; }
</style>
