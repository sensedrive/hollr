<script lang="ts">
  let { add, del }: { add: number; del: number } = $props();
</script>

<span class="pm"><span class="a">+{add}</span><span class="d">-{del}</span></span>

<style>
  .pm { display: inline-flex; gap: 6px; font-family: var(--mono); font-size: 12px; white-space: nowrap; flex: none; }
  .a { color: var(--green); } .d { color: var(--red); }
</style>
