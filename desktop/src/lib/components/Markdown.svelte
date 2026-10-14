<script lang="ts">
  // Agent answer as GitHub-flavoured Markdown (AgentMarkdown.swift). Long answers start folded unless `plain`
  // (omp transcript style). Link clicks go to `onLink` (the session view asks: Hollr browser or system browser).
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { t } from "../i18n";

  let { text, plain = false, dimmed = false, onLink }: {
    text: string; plain?: boolean; dimmed?: boolean; onLink?: (url: string) => void;
  } = $props();

  const COLLAPSE_AT = 900;
  let expanded = $state(false);

  /** First paragraphs up to the limit, never cutting inside a code block or table. */
  function preview(s: string): string {
    const out: string[] = [];
    let count = 0;
    let fence = false;
    for (const line of s.split("\n")) {
      if (line.trim().startsWith("```")) fence = !fence;
      out.push(line);
      count += line.length + 1;
      if (count > COLLAPSE_AT && !fence && !line.trim().startsWith("|")) break;
    }
    if (fence) out.push("```");
    return `${out.join("\n")}\n\n…`;
  }

  const long = $derived(!plain && text.length > COLLAPSE_AT);
  const html = $derived(DOMPurify.sanitize(marked.parse(long && !expanded ? preview(text) : text, { async: false, gfm: true }) as string));

  function click(e: MouseEvent) {
    const a = (e.target as HTMLElement | null)?.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href && !href.startsWith("#")) onLink?.(a.href || href);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" class:card={!plain} class:dimmed onclick={click}>
  {@html html}
  {#if long}
    <button class="more" onclick={() => (expanded = !expanded)}>{expanded ? t("Weniger anzeigen") : t("Ganze Antwort anzeigen")}</button>
  {/if}
</div>

<style>
  .md { user-select: text; overflow-wrap: anywhere; line-height: 1.55; padding: 0 4px; }
  .md.card { background: var(--card); border-radius: 16px; padding: 10px 14px; }
  .md.dimmed { opacity: 0.75; }
  .md :global(p) { margin: 0 0 10px; }
  .md :global(p:last-child), .md :global(ul:last-child), .md :global(ol:last-child), .md :global(pre:last-child) { margin-bottom: 0; }
  .md :global(h1) { font-size: 1.25em; margin: 12px 0 6px; }
  .md :global(h2) { font-size: 1.12em; margin: 10px 0 4px; }
  .md :global(h3), .md :global(h4) { font-size: 1em; margin: 8px 0 4px; }
  .md :global(ul), .md :global(ol) { margin: 0 0 10px; padding-left: 22px; }
  .md :global(li + li) { margin-top: 0.2em; }
  .md :global(a) { color: var(--accent); text-decoration: none; cursor: pointer; }
  .md :global(a:hover) { text-decoration: underline; }
  .md :global(strong) { font-weight: 600; }
  .md :global(code) { font-family: var(--mono); font-size: 0.85em; }
  .md :global(:not(pre) > code) { background: color-mix(in srgb, var(--fg) 8%, transparent); padding: 1px 5px; border-radius: 5px; }
  .md :global(pre) { background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 10px 12px; border-radius: 10px;
    overflow-x: auto; margin: 0 0 10px; line-height: 1.45; }
  .md :global(pre code) { font-size: 0.82em; }
  .md :global(table) { border-collapse: collapse; margin: 0 0 10px; font-size: 0.88em; display: block; overflow-x: auto; max-width: 100%; }
  .md :global(th) { font-weight: 600; background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .md :global(td), .md :global(th) { border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); padding: 6px 10px; }
  .md :global(tr:nth-child(even) td) { background: color-mix(in srgb, var(--fg) 4%, transparent); }
  .md :global(blockquote) { margin: 0 0 10px; padding-left: 10px; border-left: 3px solid color-mix(in srgb, var(--fg) 20%, transparent); color: var(--muted); }
  .md :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
  .md :global(img) { max-width: 100%; }
  .more { all: unset; cursor: pointer; display: block; margin-top: 8px; font-size: 12.5px; font-weight: 600; color: var(--accent); }
  .more:hover { text-decoration: underline; }
</style>
