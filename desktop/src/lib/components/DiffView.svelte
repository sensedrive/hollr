<script lang="ts">
  // Unified or side-by-side diff: line numbers, colored gutter, syntax colors, unchanged runs folded (click to expand).
  import { extOf, fold, highlight, parseDiff, splitRows, type DiffLine } from "../git";
  import { t } from "../i18n";
  import Icon from "./git/Icon.svelte";
  import PlusMinus from "./git/PlusMinus.svelte";

  let { text, split = false, wrap = false }: { text: string; split?: boolean; wrap?: boolean } = $props();

  const files = $derived(parseDiff(text));
  let open = $state<Record<number, boolean>>({});
  let collapsed = $state<Record<string, boolean>>({});
  let root: HTMLElement | undefined = $state();
  // a new diff: forget expanded folds / collapsed files (line ids restart)
  $effect(() => { void text; open = {}; collapsed = {}; });

  const digits = $derived(
    String(Math.max(1, ...files.flatMap((f) => f.lines.map((l) => Math.max(l.old ?? 0, l.new ?? 0))))).length,
  );
  const hl = (l: DiffLine | undefined, ext: string) => (l ? highlight(l.text, ext) || " " : "");
  const jump = (i: number) => root?.querySelector(`[data-file="${i}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const setAll = (v: boolean) => (collapsed = Object.fromEntries(files.map((f) => [f.path, v])));
</script>

<div class="diff" class:wrap={wrap || split} class:split bind:this={root} style="--digits:{digits}">
  {#if !files.length}
    <div class="empty"><Icon name="check" size={24} /><b>{t("Keine Änderungen")}</b></div>
  {/if}

  {#if files.length > 1}
    <div class="index">
      <div class="ihead">
        <span>{t("{n} Dateien", { n: files.length })}</span>
        <PlusMinus add={files.reduce((n, f) => n + f.add, 0)} del={files.reduce((n, f) => n + f.del, 0)} />
        <span class="sp"></span>
        <button class="lnk" onclick={() => setAll(false)}>{t("Alle aufklappen")}</button>
        <button class="lnk" onclick={() => setAll(true)}>{t("Alle zuklappen")}</button>
      </div>
      <div class="chips">
        {#each files as f, i}
          <button class="chip" onclick={() => { collapsed[f.path] = false; jump(i); }} title={f.path}>
            {f.path.split("/").pop()} <span class="a">+{f.add}</span><span class="d">-{f.del}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#each files as f, fi (f.path + fi)}
    {@const ext = extOf(f.path)}
    <section class="file" data-file={fi}>
      <button class="head" onclick={() => (collapsed[f.path] = !collapsed[f.path])}>
        <span class="chev"><Icon name={collapsed[f.path] ? "chevronR" : "chevronD"} size={12} /></span>
        <span class="dot"></span>
        <span class="path"><bdi>{f.path}</bdi></span>
        <PlusMinus add={f.add} del={f.del} />
      </button>
      {#if !collapsed[f.path]}
        <div class="scroller">
          <div class="lines">
            {#if f.binary && !f.lines.length}<div class="note">{t("Binärdatei")}</div>{/if}
            {#each fold(f.lines) as block}
              {#if "fold" in block && !open[block.fold[0].id]}
                <button class="foldrow" onclick={() => (open[block.fold[0].id] = true)}>
                  <Icon name="expand" size={12} /><span>{t("{n} unveränderte Zeilen", { n: block.fold.length })}</span>
                </button>
              {:else}
                {@const lines = "fold" in block ? block.fold : block.lines}
                {#if split}
                  {#each splitRows(lines) as r (r.id)}
                    {#if r.gap}
                      <div class="row gap"><span class="no"></span><code>…</code></div>
                    {:else}
                      <div class="row two">
                        <div class="half {r.left ? r.left.kind : 'none'}">
                          <span class="no">{r.left?.old ?? ""}</span><code>{@html hl(r.left, ext)}</code>
                        </div>
                        <div class="half {r.right ? r.right.kind : 'none'}">
                          <span class="no">{r.right?.new ?? ""}</span><code>{@html hl(r.right, ext)}</code>
                        </div>
                      </div>
                    {/if}
                  {/each}
                {:else}
                  {#each lines as l (l.id)}
                    <div class="row {l.kind}">
                      {#if l.kind === "gap"}
                        <span class="no"></span><span class="no"></span><span class="sign"></span><code>…</code>
                      {:else}
                        <span class="no">{l.old ?? ""}</span><span class="no">{l.new ?? ""}</span>
                        <span class="sign">{l.kind === "added" ? "+" : l.kind === "removed" ? "−" : ""}</span>
                        <code>{@html hl(l, ext)}</code>
                      {/if}
                    </div>
                  {/each}
                {/if}
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .diff { padding: 12px 14px 40px; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; color: var(--green); }
  .empty b { color: var(--fg); font-size: 15px; }
  .index { margin-bottom: 12px; }
  .ihead { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .sp { flex: 1; }
  .lnk { all: unset; cursor: pointer; color: var(--accent); font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { all: unset; cursor: pointer; font-size: 11.5px; padding: 2px 8px; border-radius: 99px; background: var(--card); border: 1px solid var(--border);
    font-family: var(--mono); display: inline-flex; gap: 5px; }
  .chip:hover { border-color: var(--accent); }
  .a { color: var(--green); } .d { color: var(--red); }

  .file { margin-bottom: 14px; border: 1px solid var(--border); border-radius: 10px; overflow: clip; background: var(--bg); }
  .head { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px;
    background: var(--card); position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--border); font-size: 13px; }
  .chev { color: var(--dim); display: inline-flex; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--purple); flex: none; }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .scroller { overflow-x: auto; }
  .lines { min-width: 100%; width: max-content; font-family: var(--mono); font-size: 12px; line-height: 1.6; }
  .wrap .lines { width: auto; }
  .row { display: flex; border-left: 3px solid transparent; }
  .row.added { background: color-mix(in srgb, var(--green) 14%, transparent); border-left-color: var(--green); }
  .row.removed { background: color-mix(in srgb, var(--red) 16%, transparent); border-left-color: var(--red); }
  .row.gap { color: var(--dim); background: color-mix(in srgb, var(--fg) 3%, transparent); }
  .no { width: calc(var(--digits) * 1ch + 16px); text-align: right; padding-right: 8px; color: var(--dim); flex: none; user-select: none; }
  .row.added .no { color: color-mix(in srgb, var(--green) 70%, var(--dim)); }
  .row.removed .no { color: color-mix(in srgb, var(--red) 70%, var(--dim)); }
  .sign { width: 16px; flex: none; text-align: center; user-select: none; color: var(--dim); }
  .row.added .sign { color: var(--green); } .row.removed .sign { color: var(--red); }
  code { white-space: pre; padding-right: 16px; tab-size: 4; flex: 1; }
  .wrap code { white-space: pre-wrap; word-break: break-word; min-width: 0; }
  .row.two { border-left: 0; }
  .half { flex: 1 1 50%; min-width: 0; display: flex; border-left: 3px solid transparent; }
  .half + .half { border-left-color: var(--border); }
  .half.added { background: color-mix(in srgb, var(--green) 14%, transparent); box-shadow: inset 3px 0 0 var(--green); }
  .half.removed { background: color-mix(in srgb, var(--red) 16%, transparent); box-shadow: inset 3px 0 0 var(--red); }
  .half.none { background: repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--fg) 3%, transparent) 6px 7px); }
  .half .no { padding-left: 4px; }
  .foldrow { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 12px;
    color: var(--muted); font: 12px/1.6 -apple-system, system-ui, sans-serif; background: color-mix(in srgb, var(--accent) 7%, transparent);
    border-top: 1px dashed var(--border); border-bottom: 1px dashed var(--border); }
  .foldrow:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 13%, transparent); }
  .note { padding: 10px 14px; color: var(--muted); }
  .diff :global(.hl-k) { color: var(--pink); } .diff :global(.hl-s) { color: var(--yellow); } .diff :global(.hl-c) { color: var(--dim); font-style: italic; }
  .diff :global(.hl-n) { color: var(--purple); } .diff :global(.hl-t) { color: var(--cyan); } .diff :global(.hl-p) { color: var(--muted); }
</style>
