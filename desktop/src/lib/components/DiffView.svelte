<script lang="ts">
  // Unified diff with line numbers, colored gutter, syntax colors and folded unchanged runs.
  import { extOf, fold, highlight, parseDiff } from "../git";
  let { text }: { text: string } = $props();
  const files = $derived(parseDiff(text));
  let open = $state<Record<number, boolean>>({});
  let collapsed = $state<Record<string, boolean>>({});
</script>

{#if !files.length}<div class="dim pad">Keine Änderungen</div>{/if}
{#each files as f}
  <div class="file">
    <button class="head" onclick={() => (collapsed[f.path] = !collapsed[f.path])}>
      <span class="dim">{collapsed[f.path] ? "▸" : "▾"}</span> {f.path}
      <span class="stat"><span class="add">+{f.add}</span> <span class="del">-{f.del}</span></span>
    </button>
    {#if !collapsed[f.path]}
      {#each fold(f.lines) as block}
        {#if "fold" in block}
          {#if open[block.fold[0].id]}
            {#each block.fold as l}<div class="ln ctx"><span class="no">{l.new}</span><code>{@html highlight(l.text, extOf(f.path)) || " "}</code></div>{/each}
          {:else}
            <button class="foldrow" onclick={() => (open[block.fold[0].id] = true)}>↕ {block.fold.length} unveränderte Zeilen</button>
          {/if}
        {:else}
          {#each block.lines as l}
            <div class="ln {l.kind}">
              <span class="no">{l.kind === "removed" ? l.old : (l.new ?? "")}</span>
              <code>{@html l.kind === "gap" ? "…" : highlight(l.text, extOf(f.path)) || " "}</code>
            </div>
          {/each}
        {/if}
      {/each}
    {/if}
  </div>
{/each}

<style>
  .file { margin-bottom: 14px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .head { all: unset; cursor: pointer; display: flex; gap: 8px; width: calc(100% - 24px); padding: 8px 12px; background: var(--card); }
  .stat { margin-left: auto; font-family: var(--mono); font-size: 12px; }
  .add { color: var(--green); } .del { color: var(--red); }
  .ln { display: flex; font-family: var(--mono); font-size: 12px; line-height: 1.55; border-left: 3px solid transparent; }
  .ln.added { background: color-mix(in srgb, var(--green) 14%, transparent); border-left-color: var(--green); }
  .ln.removed { background: color-mix(in srgb, var(--red) 16%, transparent); border-left-color: var(--red); }
  .ln.gap { color: var(--dim); }
  .no { width: 48px; text-align: right; padding-right: 10px; color: var(--dim); flex-shrink: 0; user-select: none; }
  code { white-space: pre-wrap; word-break: break-all; }
  .foldrow { all: unset; cursor: pointer; display: block; width: 100%; padding: 6px 12px; color: var(--muted); font-size: 12px;
    background: color-mix(in srgb, var(--fg) 4%, transparent); }
  .pad { padding: 16px; }
  :global(.k) { color: #f286c4; } :global(.s) { color: #e9b96e; } :global(.c) { color: var(--dim); }
  :global(.n) { color: #b4a1ff; } :global(.t) { color: #6cc5e8; }
</style>
