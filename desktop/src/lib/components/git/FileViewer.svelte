<script lang="ts">
  // File content: line numbers + syntax colors; Markdown rendered (toggle source/preview); wrap toggle.
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import * as git from "../../git";
  import { t } from "../../i18n";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";

  let { server, ws, path, rev = 0 }: { server: string; ws: string; path: string; rev?: number } = $props();

  let content = $state<git.FileContent | null>(null);
  let error = $state("");
  let rendered = $state(true);
  let wrap = $state(git.pref("wrap", false));

  let seq = 0;
  $effect(() => {
    void rev;
    const p = path;
    const n = ++seq;
    content = null; error = "";
    git.read(server, ws, p).then((c) => { if (n === seq) content = c; }, (e) => { if (n === seq) error = String(e); });
  });

  const isMarkdown = $derived(/\.(md|mdx|markdown)$/i.test(path));
  const ext = $derived(git.extOf(path));
  const lines = $derived(content && !content.binary ? content.text.replace(/\n$/, "").split("\n") : []);
  const html = $derived(isMarkdown && content && !content.binary ? DOMPurify.sanitize(marked.parse(content.text, { async: false }) as string) : "");
  const digits = $derived(String(lines.length).length);
</script>

<div class="viewer">
  <header class="bar">
    <span class="title" title={path}><bdi><span class="dir">{git.dirName(path) ? git.dirName(path) + "/" : ""}</span><b>{git.baseName(path)}</b></bdi></span>
    {#if content && !content.binary}<span class="meta">{t("{n} Zeilen", { n: lines.length })} · {git.bytes(content.size)}</span>{/if}
    <span class="tools">
      {#if isMarkdown}
        <button class="tb" class:on={rendered} onclick={() => (rendered = !rendered)} title={rendered ? t("Quelltext") : t("Vorschau")}>
          <Icon name={rendered ? "code" : "eye"} size={14} /><span>{rendered ? t("Quelltext") : t("Vorschau")}</span>
        </button>
      {/if}
      {#if !(isMarkdown && rendered)}
        <button class="tb" class:on={wrap} onclick={() => { wrap = !wrap; git.setPref("wrap", wrap); }}
          title={wrap ? t("Nicht umbrechen") : t("Zeilen umbrechen")}><Icon name="wrap" size={14} /></button>
      {/if}
    </span>
  </header>

  <div class="body">
    {#if error}
      <div class="empty"><Icon name="x" size={22} /><b>{t("Fehler")}</b><span class="err">{error}</span></div>
    {:else if !content}
      <Skeleton kind="code" count={30} />
    {:else if content.binary}
      <div class="empty"><Icon name="doc" size={26} /><b>{t("Binärdatei")}</b><span class="dim">{git.bytes(content.size)}</span></div>
    {:else if isMarkdown && rendered}
      <article class="md">{@html html}</article>
    {:else}
      <div class="code" class:wrap style="--digits:{digits}">
        {#each lines as line, i}
          <div class="ln"><span class="no">{i + 1}</span><code>{@html git.highlight(line, ext) || " "}</code></div>
        {/each}
      </div>
    {/if}
    {#if content?.truncated}
      <div class="trunc dim">{t("… gekürzt ({size})", { size: git.bytes(content.size) })}</div>
    {/if}
  </div>
</div>

<style>
  .viewer { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); min-height: 42px; }
  .title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; font-size: 13px; }
  .title .dir { color: var(--muted); }
  .meta { font-size: 11.5px; color: var(--dim); white-space: nowrap; }
  .tools { margin-left: auto; display: flex; gap: 4px; }
  .tb { display: inline-flex; align-items: center; gap: 6px; background: none; border: 1px solid transparent; border-radius: 7px; padding: 4px 8px;
    color: var(--muted); font-size: 12px; }
  .tb:hover { border-color: var(--border); color: var(--fg); }
  .tb.on { background: var(--card); border-color: var(--border); color: var(--fg); }
  .body { flex: 1; overflow: auto; min-height: 0; }
  .code { font-family: var(--mono); font-size: 12px; line-height: 1.6; padding: 8px 0 24px; min-width: max-content; }
  .code.wrap { min-width: 0; }
  .ln { display: flex; }
  .ln:hover { background: color-mix(in srgb, var(--fg) 4%, transparent); }
  .no { width: calc(var(--digits) * 1ch + 22px); text-align: right; padding-right: 14px; color: var(--dim); flex: none; user-select: none; }
  code { white-space: pre; padding-right: 16px; tab-size: 4; }
  .wrap code { white-space: pre-wrap; word-break: break-word; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 20px; color: var(--muted); text-align: center; }
  .empty b { color: var(--fg); font-size: 15px; }
  .trunc { padding: 10px 16px 20px; font-size: 12px; }
  .md { padding: 18px 26px 40px; max-width: 860px; line-height: 1.6; }
  .md :global(h1), .md :global(h2) { border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  .md :global(pre) { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow: auto; }
  .md :global(code) { font-family: var(--mono); font-size: .9em; white-space: pre; }
  .md :global(:not(pre) > code) { background: var(--card); padding: 1px 5px; border-radius: 5px; }
  .md :global(a) { color: var(--accent); }
  .md :global(img) { max-width: 100%; }
  .md :global(table) { border-collapse: collapse; }
  .md :global(td), .md :global(th) { border: 1px solid var(--border); padding: 4px 8px; }
  .md :global(blockquote) { margin: 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
  .viewer :global(.hl-k) { color: var(--pink); } .viewer :global(.hl-s) { color: var(--yellow); } .viewer :global(.hl-c) { color: var(--dim); font-style: italic; }
  .viewer :global(.hl-n) { color: var(--purple); } .viewer :global(.hl-t) { color: var(--cyan); } .viewer :global(.hl-p) { color: var(--muted); }
</style>
