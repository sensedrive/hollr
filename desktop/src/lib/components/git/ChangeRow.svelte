<script lang="ts">
  // One changed file: status badge, name + folder, +/- and an optional trailing control.
  import type { Snippet } from "svelte";
  import { baseName, dirName, type FileChange } from "../../git";
  import PlusMinus from "./PlusMinus.svelte";
  import StatusBadge from "./StatusBadge.svelte";

  let { file, selected = false, index, onclick, trailing }:
    { file: FileChange; selected?: boolean; index?: number; onclick: () => void; trailing?: Snippet } = $props();
</script>

<div class="cr" class:sel={selected} data-i={index}>
  <button class="main" {onclick} title={file.path}>
    <StatusBadge status={file.status} />
    <span class="txt">
      <span class="name">{baseName(file.path)}</span>
      {#if dirName(file.path)}<span class="dir"><bdi>{dirName(file.path)}</bdi></span>{/if}
    </span>
    <PlusMinus add={file.add} del={file.del} />
  </button>
  {@render trailing?.()}
</div>

<style>
  .cr { display: flex; align-items: center; gap: 4px; border-radius: 8px; padding-right: 6px; }
  .cr:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .cr.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .main { all: unset; cursor: pointer; flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 6px 4px 6px 8px; }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dir { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
</style>
