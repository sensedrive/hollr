<script lang="ts">
  import Sym from "$lib/components/Sym.svelte";
  import Icon from "$lib/components/git/Icon.svelte";
  // A tool call's status mark like omp's: spinner while running, ✘ on error, the tool's glyph when done.
  import type { ToolCall } from "../../api";
  let { status, ok, color = "var(--fg)" }: { status: ToolCall["status"]; ok: string; color?: string } = $props();
</script>

{#if status === "running"}<span class="braille acc"></span>
{:else if status === "error"}<span class="err"><Icon name="✘" size={15} /></span>
{:else}<span style:color><Sym g={ok} /></span>{/if}
