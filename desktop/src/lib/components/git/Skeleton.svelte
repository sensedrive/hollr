<script lang="ts">
  // Loading placeholders shaped like the content (list rows, code lines, history graph).
  let { kind = "list", count = 10 }: { kind?: "list" | "code" | "graph"; count?: number } = $props();
  const w = (i: number) => 35 + ((i * 37) % 50);
</script>

<div class="sk {kind}" aria-busy="true">
  {#each Array(count) as _, i}
    <div class="line">
      {#if kind === "list"}<span class="skeleton ic"></span>
      {:else if kind === "code"}<span class="skeleton no"></span>
      {:else}<span class="lane" style="width:{12 + (i % 3) * 14}px"><span class="skeleton dot"></span></span>{/if}
      <span class="skeleton bar" style="width:{kind === 'code' ? w(i) * 0.9 : w(i)}%; {kind === 'code' ? `margin-left:${(i % 4) * 14}px` : ''}"></span>
      {#if kind !== "code"}<span class="skeleton tail"></span>{/if}
    </div>
  {/each}
</div>

<style>
  .sk { padding: 6px 4px; }
  .line { display: flex; align-items: center; gap: 12px; height: 34px; }
  .code .line { height: 20px; gap: 14px; }
  .ic { width: 22px; height: 22px; border-radius: 6px; flex: none; }
  .no { width: 26px; height: 10px; border-radius: 4px; flex: none; opacity: .6; }
  .bar { height: 11px; border-radius: 5px; }
  .tail { width: 28px; height: 10px; margin-left: auto; border-radius: 5px; flex: none; }
  .lane { display: flex; justify-content: flex-end; flex: none; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
</style>
