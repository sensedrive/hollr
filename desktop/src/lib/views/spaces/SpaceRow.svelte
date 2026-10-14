<script lang="ts">
  // One space in the list: status ring, name, branch / dirty / ahead / behind, last commit.
  import { t } from "$lib/i18n";
  import { relTime, statusColor } from "../dashboard/util";
  import { folderOf, type FullSpace } from "./spaces";

  let { space, nested = false, last = false, onOpen, onClose, onMenu }: {
    space: FullSpace; nested?: boolean; last?: boolean; onOpen: () => void; onClose: () => void; onMenu: (e: MouseEvent) => void;
  } = $props();
  const st = $derived(space.status ?? "unknown");
</script>

<div class="wrap">
  <button class="item" data-nav onclick={onOpen} oncontextmenu={(e) => { e.preventDefault(); onMenu(e); }}>
    {#if nested}<span class="tree mono">{last ? "└─" : "├─"}</span>{/if}
    <span class="ring" style="--c:{statusColor(st)}" class:fill={st === "working"}></span>
    <span class="grow text">
      <span class="label ellipsis" class:strong={!nested}>{space.label}
        {#if space.isWorktree}<span class="pill">worktree</span>{/if}
        {#if space.paneCount}<span class="dim small"> · {space.paneCount}</span>{/if}
      </span>
      {#if space.git}
        <span class="git mono small">
          <span class="branch">⑂ {space.git.branch}</span>
          {#if space.git.dirty > 0}<span style="color:var(--orange)">*{space.git.dirty}</span>{/if}
          {#if space.git.ahead > 0}<span style="color:var(--green)">↑{space.git.ahead}</span>{/if}
          {#if space.git.behind > 0}<span style="color:var(--red)">↓{space.git.behind}</span>{/if}
        </span>
        {#if space.git.lastCommit}
          <span class="commit small ellipsis">{space.git.lastCommit.subject} · {relTime(space.git.lastCommit.at)}</span>
        {/if}
      {:else}
        <span class="mono small muted ellipsis">{folderOf(space.root)}</span>
      {/if}
    </span>
    <span class="root mono small dim ellipsis">{space.root}</span>
  </button>
  <button class="close" title={t("Schließen …")} aria-label={t("Schließen …")} onclick={onClose}>✕</button>
</div>

<style>
  .wrap { position: relative; }
  .item { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 14px; cursor: pointer; }
  .item:hover, .item:focus-visible { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tree { color: var(--border); }
  .ring { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--c); flex: none; box-sizing: border-box; }
  .ring.fill { background: var(--c); }
  .text { display: grid; gap: 1px; }
  .label.strong { font-weight: 600; }
  .label .pill { margin-left: 6px; }
  .git { display: flex; gap: 8px; }
  .branch { color: var(--purple); }
  .commit { color: var(--dim); }
  .root { max-width: 34%; text-align: right; }
  .close { all: unset; position: absolute; right: 10px; top: 50%; translate: 0 -50%; width: 24px; height: 24px; display: grid; place-items: center;
    border-radius: 6px; color: var(--muted); background: var(--card); border: 1px solid var(--border); font-size: 11px; cursor: pointer; opacity: 0; }
  .wrap:hover .close, .close:focus-visible { opacity: 1; }
  .wrap:hover .root { visibility: hidden; }
  .close:hover { color: var(--red); border-color: var(--red); }
</style>
