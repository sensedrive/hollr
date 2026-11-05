<script lang="ts">
  // Hollr desktop: the main window's shell – or, in a window of its own, one side conversation
  // (`?window=side&…`, opened by src-tauri/src/window.rs).
  import "../app.css";
  import { appearance } from "$lib/appearance.svelte";
  import { sideParams } from "$lib/sidetalk";
  import Shell from "$lib/views/Shell.svelte";
  import SideWindow from "$lib/views/SideWindow.svelte";

  appearance();
  const side = sideParams(location.search);
</script>

{#if side}
  <SideWindow {...side} />
{:else}
  <Shell />
{/if}
