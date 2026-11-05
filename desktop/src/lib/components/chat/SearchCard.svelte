<script lang="ts">
  // grep / glob / find / ls: the query line like omp, below it the hits as a tree – grep with line numbers and the
  // match marked, the others as a file list. Short lists start open, long ones show their head and fold the rest.
  import type { ToolCall } from "../../api";
  import { shortPath, toolIcon, toolTitle } from "../../agent";
  import { markHits, searchScopes, underRoot, type Seg } from "../../chatTools";
  import Glyph from "./Glyph.svelte";
  import More from "./More.svelte";
  import PathText from "./PathText.svelte";

  let { c, root, tip, onLink }: { c: ToolCall; root?: string; tip: string; onLink?: (url: string) => void } = $props();

  /** `path`: the file as the agent gave it (what a click opens), `file` how it shows */
  type Row = { path: string; file: string; last: boolean } | { path: string; n: number; segs: Seg[]; lastFile: boolean };
  const rel = (p: string) => underRoot(p, root) ?? shortPath(p);
  const rows = $derived.by((): Row[] => {
    if (c.matches?.length) {
      const pattern = c.name === "grep" ? c.detail : undefined;
      return c.matches.flatMap((m, i, all) => {
        const last = i === all.length - 1;
        return [{ path: m.file, file: rel(m.file), last }, ...m.lines.map((l) => ({ path: m.file, n: l.n, segs: markHits(l.text, pattern), lastFile: last }))];
      });
    }
    return (c.files ?? []).map((f, i, all) => ({ path: f, file: rel(f), last: i === all.length - 1 }));
  });
  const SMALL = 14;
  const PREVIEW = 8;
  let open = $state<boolean | undefined>(undefined);
  const isOpen = $derived(open ?? rows.length <= SMALL);
  const shown = $derived(isOpen ? rows : rows.slice(0, PREVIEW));
  /** omp searches several paths at once ("a;b;c") – listed readably, each relative to the space */
  const where = $derived.by(() => {
    const scopes = searchScopes(c.path).map(rel).filter((s) => s !== ".");
    return scopes.length ? ` · in ${scopes.join(", ")}` : "";
  });
  const toggle = () => {
    if (rows.length > PREVIEW && !window.getSelection()?.toString()) open = !isOpen;
  };
</script>

<div class="line" title={tip}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hrow" class:click={rows.length > PREVIEW} onclick={toggle}>
    <Glyph status={c.status} ok={toolIcon(c.name)} color="var(--muted)" />
    <span class="clamp2 sel"><b>{toolTitle(c.name)}</b>{#if c.detail}<span class="muted">{` ${c.detail}`}</span>{/if}<span class="dim">{c.status !== "error" && c.result ? ` · ${c.result}` : ""}{where}</span></span>
  </div>
  {#if c.status === "error" && c.result}<div class="err indent clamp3 sel">{c.result}</div>{/if}
  {#if shown.length}
    <div class="hits sel">
      {#each shown as r, i (i)}
        {#if "file" in r}
          <div class="hrow"><span class="tree">{r.last ? "└─" : "├─"}</span><span class="ellipsis"><PathText path={r.path} {onLink} class="acc">{r.file}</PathText></span></div>
        {:else}
          <div class="hrow hit">
            <span class="tree">{r.lastFile ? "  " : "│ "}</span>
            <span class="no"><PathText path={r.path} line={r.n} {onLink}>{r.n}</PathText></span>
            <span class="txt">{#each r.segs as s, j (j)}{#if s.hit}<mark>{s.s}</mark>{:else}{s.s}{/if}{/each}</span>
          </div>
        {/if}
      {/each}
    </div>
    {#if rows.length > PREVIEW}
      <div class="indent"><More open={isOpen} hidden={rows.length - shown.length} unit={c.matches?.length ? "lines" : "files"} ontoggle={() => (open = !isOpen)} /></div>
    {/if}
  {/if}
</div>

<style>
  .hits { padding-left: 4px; line-height: 1.5; }
  .hit { gap: 0; }
  .tree { white-space: pre; flex: none; }
  .no { flex: none; min-width: 3ch; text-align: right; padding: 0 6px 0 4px; color: var(--dim); user-select: none; }
  .txt { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }
  mark { background: color-mix(in srgb, var(--yellow) 28%, transparent); color: var(--fg); border-radius: 2px; }
</style>
