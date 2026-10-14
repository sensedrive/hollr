<script lang="ts">
  let { server, ws }: { server: string; ws: string } = $props();
</script>

<div class="page"><h1>{ws}</h1><p class="dim">{server}</p></div>
