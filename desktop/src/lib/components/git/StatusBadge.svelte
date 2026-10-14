<script lang="ts">
  import { statusColor, statusLabel } from "../../git";
  let { status }: { status: string } = $props();
</script>

<span class="badge" style="--c:{statusColor(status)}">{statusLabel(status)}</span>

<style>
  .badge { width: 22px; height: 22px; flex: none; display: inline-grid; place-items: center; border-radius: 6px;
    font: 650 12px/1 var(--mono); color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
</style>
