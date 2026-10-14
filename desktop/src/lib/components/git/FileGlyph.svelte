<script lang="ts">
  // File-type badge (FileIcon on iOS): folder icon or a tinted letter tile.
  import { fileIcon } from "../../git";
  import Icon from "./Icon.svelte";
  let { name, dir = false }: { name: string; dir?: boolean } = $props();
  const ic = $derived(fileIcon(name, dir));
</script>

{#if dir}
  <span class="g dir" style="color:{ic.color}"><Icon name="folder" size={17} /></span>
{:else}
  <span class="g" style="--c:{ic.color}" class:long={ic.glyph.length > 2}>{ic.glyph}</span>
{/if}

<style>
  .g { width: 22px; height: 22px; flex: none; display: inline-grid; place-items: center; border-radius: 6px;
    font: 700 9.5px/1 var(--mono); letter-spacing: -.02em; color: var(--c);
    background: color-mix(in srgb, var(--c) 15%, transparent); }
  .g.long { font-size: 8px; }
  .g.dir { background: none; }
</style>
