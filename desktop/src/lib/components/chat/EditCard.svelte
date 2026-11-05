<script lang="ts">
  // edit / write: file header (type tile, path relative to the space, +/-) and the change as diff hunks with line
  // numbers and syntax colors. Small diffs start open, big ones show their first lines and fold the rest.
  import type { ToolCall } from "../../api";
  import { shortPath, toolIcon, toolTitle } from "../../agent";
  import { diffRows, diffSlice, gutterDigits, underRoot } from "../../chatTools";
  import { extOf, highlight } from "../../git";
  import { t } from "../../i18n";
  import FileGlyph from "../git/FileGlyph.svelte";
  import Glyph from "./Glyph.svelte";
  import More from "./More.svelte";
  import PathText from "./PathText.svelte";
  import { revealed } from "./reveal";

  let { c, root, tip, copy, onLink }: {
    c: ToolCall; root?: string; tip: string; copy: (s: string) => void; onLink?: (url: string) => void;
  } = $props();

  const full = $derived(c.file ?? c.detail ?? "");
  /** the path opens where the change starts */
  const firstLine = $derived(c.diff?.[0]?.lines.find((l) => l.t !== " " && l.n)?.n);
  const path = $derived(underRoot(full, root) ?? shortPath(full));
  const rows = $derived(diffRows(c.diff ?? []));
  /** a write to a device, not a file (omp's `agent://x` message, `xd://` tool call): one quiet line, no file card */
  const device = $derived(!rows.length && /^[a-z][a-z0-9+.-]*:\/\//i.test(full) && !full.startsWith("local://"));
  const digits = $derived(gutterDigits(rows));
  /** syntax per row: multi-file edits switch the language at each file row */
  const exts = $derived.by(() => {
    let ext = extOf(path);
    return rows.map((r) => ("file" in r ? (ext = extOf(r.file)) : ext));
  });
  let open = $state<boolean | undefined>(undefined);
  const reveal = revealed();
  // the find bar opens a diff with a hit in its folded rows
  const view = $derived(diffSlice(rows, reveal.has(c.id) || open));

  const toggle = () => {
    if (rows.length && !window.getSelection()?.toString()) open = !view.isOpen;
  };
  /** the change as unified-diff text (what "Diff kopieren" puts on the clipboard) */
  const unified = () =>
    rows.map((r) => ("gap" in r ? "…" : "file" in r ? `--- ${r.file}` : `${r.t}${r.text}`)).join("\n");
</script>

<div class={device ? "line" : `frame soft ${c.status}`} class:flush={rows.length > 0} title={tip}>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex (role/tabindex only while there is a diff to fold) -->
  <div class="head hrow mid" class:click={rows.length > 0} class:bar={rows.length > 0} onclick={toggle}
    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
    role={rows.length ? "button" : undefined} tabindex={rows.length ? 0 : undefined} aria-expanded={rows.length ? view.isOpen : undefined}>
    {#if c.status === "ok" && path && !device}<FileGlyph name={path} />{:else}<Glyph status={c.status} ok={device ? "→" : toolIcon(c.name)} color="var(--orange)" />{/if}
    <span class="grow clamp2 sel"><b>{toolTitle(c.name)}</b>{#if path}{" "}<PathText path={device ? "" : full} line={firstLine} {onLink} class={device ? "muted" : "acc"}>{path}</PathText>{/if}</span>
    {#if (c.add ?? 0) + (c.del ?? 0) > 0}
      <span class="nowrap pm">{#if c.add}<span class="ok">+{c.add}</span>{/if}{#if c.del}<span class="err">−{c.del}</span>{/if}</span>
    {/if}
    {#if rows.length && view.foldable}<span class="dim chev">{view.isOpen ? "▾" : "▸"}</span>{/if}
    <span class="acts inline">
      {#if full}<button class="act" title={t("Pfad kopieren")} onclick={(e) => { e.stopPropagation(); copy(full); }}>⧉ {t("Pfad")}</button>{/if}
      {#if rows.length}<button class="act" title={t("Änderung als Diff kopieren")} onclick={(e) => { e.stopPropagation(); copy(unified()); }}>⧉ Diff</button>{/if}
    </span>
  </div>
  {#if c.status === "error" && c.result}<div class="err clamp4 pad sel">{c.result}</div>{/if}
  {#if rows.length}
    <div class="lines" style="--digits:{digits}">
      {#each view.shown as r, i (i)}
        {#if "gap" in r}
          <div class="dl gap"><span class="no"></span><span class="sign"></span><code>⋯</code></div>
        {:else if "file" in r}
          <div class="fileRow hrow mid"><FileGlyph name={r.file} /><span class="sel"><PathText path={r.file} {onLink} class="acc">{underRoot(r.file, root) ?? shortPath(r.file)}</PathText></span></div>
        {:else}
          <div class="dl" class:add={r.t === "+"} class:del={r.t === "-"}>
            <span class="no">{r.t === "-" ? (r.o ?? "") : (r.n ?? r.o ?? "")}</span>
            <span class="sign">{r.t === "+" ? "+" : r.t === "-" ? "−" : ""}</span>
            <code>{@html highlight(r.text, exts[i] ?? "") || " "}</code>
          </div>
        {/if}
      {/each}
    </div>
    {#if view.hidden > 0 || (view.isOpen && view.foldable) || c.diffMore}
      <div class="foot">
        {#if view.hidden > 0 || (view.isOpen && view.foldable)}
          <More open={view.isOpen} hidden={view.hidden} ontoggle={() => (open = !view.isOpen)} />
        {/if}
        {#if c.diffMore && view.isOpen}<span class="dim">{t("… {n} weitere Zeilen nicht übertragen", { n: c.diffMore })}</span>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .head { padding: 0; }
  .head.bar { padding: 7px 12px; }
  .frame.flush .head.bar { border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
  .frame:not(.flush) .head :global(.g) { margin: -3px 0; }
  .head :global(.g) { width: 20px; height: 20px; font-size: 8.5px; }
  .pm { display: inline-flex; gap: 6px; }
  .chev { width: 10px; text-align: center; }
  .pad { padding: 6px 12px; }
  .lines { font-size: 11.5px; line-height: 1.55; padding: 4px 0; background: var(--bg); }
  .dl { display: flex; border-left: 3px solid transparent; }
  .dl.add { background: color-mix(in srgb, var(--green) 14%, transparent); border-left-color: var(--green); }
  .dl.del { background: color-mix(in srgb, var(--red) 16%, transparent); border-left-color: var(--red); }
  .dl.gap { color: var(--dim); }
  .no { width: calc(var(--digits) * 1ch + 14px); text-align: right; padding-right: 6px; color: var(--dim); flex: none; user-select: none; }
  .dl.add .no { color: color-mix(in srgb, var(--green) 70%, var(--dim)); }
  .dl.del .no { color: color-mix(in srgb, var(--red) 70%, var(--dim)); }
  .sign { width: 14px; flex: none; text-align: center; user-select: none; color: var(--dim); }
  .dl.add .sign { color: var(--green); } .dl.del .sign { color: var(--red); }
  .dl:not(.add):not(.del) code { opacity: 0.75; }
  code { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; padding-right: 12px; user-select: text; font-family: inherit; }
  .foot { display: flex; gap: 12px; align-items: baseline; padding: 4px 12px 6px; border-top: 1px dashed color-mix(in srgb, var(--border) 60%, transparent); }
  .fileRow { padding: 4px 12px; font-size: 12px; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); background: var(--raised); }
  .fileRow:first-child { border-top: 0; }
  .fileRow :global(.g) { width: 18px; height: 18px; font-size: 8px; }
</style>
