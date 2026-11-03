<script lang="ts">
  // A tool call's status mark like omp's: spinner while running, ✘ on error, the tool's glyph when done.
  import type { ToolCall } from "../../api";
  let { status, ok, color = "var(--fg)" }: { status: ToolCall["status"]; ok: string; color?: string } = $props();
</script>

{#if status === "running"}<span class="braille acc"></span>
{:else if status === "error"}<span class="err">✘</span>
{:else}<span style:color>{ok}</span>{/if}
