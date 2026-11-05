<script lang="ts">
  // A symbol that may still be one of the old Unicode glyphs (tool marks, tips, release notes): drawn as its line icon
  // when there is one, else as the character itself (letters like "λ" or "?" stay text).
  import Icon from "./git/Icon.svelte";
  import { GLYPHS } from "./git/glyphs";
  let { g, size = 14 }: { g: string; size?: number } = $props();
</script>

{#if GLYPHS[g]}<Icon name={g} {size} />{:else}{g}{/if}
