<script module lang="ts">
  import { Marked, Renderer, type Tokens } from "marked";
  import { t } from "../i18n";
  import { highlight, langOf } from "../highlight.svelte";

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const plainRenderer = new Renderer();

  // One parser for every answer: code blocks get a language label, a copy button (handled in `click`) and
  // highlighting once their language has loaded; tables scroll inside their own box with a sticky header.
  const md = new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }: Tokens.Code) {
        const name = langOf(lang);
        const body = (name && highlight(text, name)) || esc(text);
        const label = lang?.trim().split(/\s+/)[0] ?? "";
        return `<div class="codeblock"><div class="codebar">${label ? `<span class="codelang">${esc(label)}</span>` : ""}`
          + `<button type="button" class="codecopy" title="${esc(t("Code kopieren"))}" aria-label="${esc(t("Code kopieren"))}">⧉</button></div>`
          + `<pre><code class="hljs${name ? ` language-${name}` : ""}">${body}</code></pre></div>\n`;
      },
      table(token: Tokens.Table) {
        return `<div class="tablewrap">${plainRenderer.table.call(this, token)}</div>\n`;
      },
      listitem(item: Tokens.ListItem) {
        const html = plainRenderer.listitem.call(this, item);
        return item.task ? html.replace(/^<li>/, '<li class="task">') : html;
      },
    },
  });
</script>

<script lang="ts">
  // Agent answer as GitHub-flavoured Markdown (AgentMarkdown.swift). Long answers start folded unless `plain`
  // (omp transcript style). Link clicks go to `onLink` (the session view asks: Hollr browser or system browser).
  import DOMPurify from "dompurify";
  import { highlighter } from "../highlight.svelte";
  import { copy } from "../serverapi";
  import MsgActions from "./MsgActions.svelte";

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
  const html = $derived.by(() => {
    // a language that finished loading renders its blocks again, now highlighted
    void highlighter.version;
    return DOMPurify.sanitize(md.parse(long && !expanded ? preview(text) : text, { async: false }) as string);
  });

  async function click(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    const button = el?.closest<HTMLButtonElement>("button.codecopy");
    if (button) {
      const code = button.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
      if (await copy(code)) {
        button.textContent = "✓";
        button.classList.add("done");
        setTimeout(() => {
          button.textContent = "⧉";
          button.classList.remove("done");
        }, 1200);
      }
      return;
    }
    const a = el?.closest("a");
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
  <MsgActions {text} />
</div>

<style>
  .md { position: relative; user-select: text; overflow-wrap: anywhere; line-height: 1.55; padding: 0 4px; }
  .md.card { background: var(--card); border-radius: 16px; padding: 10px 14px; }
  .md.dimmed { opacity: 0.75; }
  .md > :global(:first-child) { margin-top: 0; }
  .md :global(p) { margin: 0 0 10px; }
  .md :global(:is(p, ul, ol, pre, blockquote, .codeblock, .tablewrap):last-child) { margin-bottom: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4), .md :global(h5), .md :global(h6) { line-height: 1.3; font-weight: 650; }
  .md :global(h1) { font-size: 1.3em; margin: 18px 0 8px; }
  .md :global(h2) { font-size: 1.15em; margin: 16px 0 6px; padding-bottom: 3px; border-bottom: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
  .md :global(h3) { font-size: 1.05em; margin: 14px 0 4px; }
  .md :global(h4), .md :global(h5), .md :global(h6) { font-size: 1em; margin: 12px 0 4px; color: color-mix(in srgb, var(--fg) 85%, transparent); }
  .md :global(ul), .md :global(ol) { margin: 0 0 10px; padding-left: 22px; }
  .md :global(li + li) { margin-top: 0.2em; }
  .md :global(li > ul), .md :global(li > ol) { margin: 0.2em 0 0; }
  .md :global(li::marker) { color: var(--muted); }
  /* task list: the checkbox takes the bullet's place */
  .md :global(li.task) { list-style: none; margin-left: -20px; }
  .md :global(li.task input) { appearance: none; -webkit-appearance: none; position: relative; width: 13px; height: 13px; margin: 0 7px 0 0;
    vertical-align: -2px; padding: 0; border: 1.5px solid var(--muted); border-radius: 4px; pointer-events: none; box-sizing: border-box; }
  .md :global(li.task input:checked) { background: var(--green); border-color: var(--green); }
  .md :global(li.task input:checked)::after { content: ""; position: absolute; left: 3px; top: 0; width: 3px; height: 7px;
    border: solid var(--bg); border-width: 0 2px 2px 0; transform: rotate(45deg); }
  .md :global(li.task:has(input:checked)) { color: var(--muted); }
  .md :global(a) { color: var(--accent); text-decoration: none; cursor: pointer; }
  .md :global(a:hover) { text-decoration: underline; }
  .md :global(strong) { font-weight: 600; }
  .md :global(code) { font-family: var(--mono); font-size: 0.86em; }
  .md :global(:not(pre) > code) { background: color-mix(in srgb, var(--fg) 9%, transparent); padding: 1px 5px; border-radius: 5px;
    border: 1px solid color-mix(in srgb, var(--fg) 6%, transparent); overflow-wrap: anywhere; }
  /* a file name or identifier in a table cell stays whole – the table scrolls instead */
  .md :global(td code) { overflow-wrap: normal; white-space: nowrap; }
  .md :global(blockquote) { margin: 0 0 10px; padding: 4px 12px; border-left: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
    background: color-mix(in srgb, var(--fg) 4%, transparent); border-radius: 0 8px 8px 0; color: color-mix(in srgb, var(--fg) 78%, transparent); }
  .md :global(blockquote p:last-child) { margin-bottom: 0; }
  .md :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
  .md :global(img) { max-width: 100%; }

  /* code blocks: label + copy button in the corner, highlighted with omp-like colours */
  .md :global(.codeblock) { position: relative; margin: 0 0 10px; border-radius: 10px; background: color-mix(in srgb, var(--fg) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--fg) 7%, transparent); }
  .md :global(.codebar) { position: absolute; top: 4px; right: 6px; display: flex; align-items: center; gap: 6px; z-index: 1; }
  .md :global(.codelang) { font-family: var(--mono); font-size: 10.5px; color: var(--dim); user-select: none; }
  .md :global(.codecopy) { all: unset; cursor: pointer; width: 24px; height: 22px; display: grid; place-items: center; border-radius: 6px;
    font-size: 12px; color: var(--muted); opacity: 0; background: color-mix(in srgb, var(--bg) 70%, transparent); }
  .md :global(.codeblock:hover .codecopy), .md :global(.codecopy:focus-visible), .md :global(.codecopy.done) { opacity: 1; }
  .md :global(.codecopy:hover) { color: var(--fg); background: color-mix(in srgb, var(--fg) 12%, transparent); }
  .md :global(.codecopy.done) { color: var(--green); }
  .md :global(pre) { margin: 0; padding: 10px 12px; overflow-x: auto; line-height: 1.45; }
  .md :global(pre code) { font-size: 0.82em; white-space: pre; overflow-wrap: normal; }
  .md :global(.hljs-keyword), .md :global(.hljs-selector-tag), .md :global(.hljs-built_in), .md :global(.hljs-meta .hljs-keyword) { color: var(--purple); }
  .md :global(.hljs-string), .md :global(.hljs-regexp), .md :global(.hljs-addition), .md :global(.hljs-attr .hljs-string) { color: var(--green); }
  .md :global(.hljs-number), .md :global(.hljs-literal), .md :global(.hljs-symbol), .md :global(.hljs-bullet) { color: var(--orange); }
  .md :global(.hljs-comment), .md :global(.hljs-quote) { color: var(--dim); font-style: italic; }
  .md :global(.hljs-title), .md :global(.hljs-section), .md :global(.hljs-selector-id), .md :global(.hljs-selector-class) { color: var(--accent); }
  .md :global(.hljs-attr), .md :global(.hljs-attribute), .md :global(.hljs-variable), .md :global(.hljs-template-variable),
  .md :global(.hljs-type), .md :global(.hljs-params) { color: var(--yellow); }
  .md :global(.hljs-name), .md :global(.hljs-tag), .md :global(.hljs-meta) { color: var(--red); }
  .md :global(.hljs-deletion) { color: var(--red); }
  .md :global(.hljs-emphasis) { font-style: italic; }
  .md :global(.hljs-strong) { font-weight: 700; }

  /* tables: compact, scroll sideways (and down when tall) inside their box, header stays on top */
  .md :global(.tablewrap) { margin: 0 0 10px; max-width: 100%; max-height: 460px; overflow: auto; border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); }
  .md :global(table) { border-collapse: separate; border-spacing: 0; font-size: 0.86em; min-width: 100%; }
  .md :global(th) { position: sticky; top: 0; z-index: 1; font-weight: 600; white-space: nowrap;
    background: color-mix(in srgb, var(--fg) 9%, var(--card)); }
  .md :global(th:not([align])) { text-align: left; }
  .md :global(td), .md :global(th) { padding: 4px 10px; border-bottom: 1px solid color-mix(in srgb, var(--fg) 9%, transparent); vertical-align: top; }
  .md :global(td + td), .md :global(th + th) { border-left: 1px solid color-mix(in srgb, var(--fg) 7%, transparent); }
  .md :global(tr:last-child td) { border-bottom: 0; }
  .md :global(tbody tr:nth-child(even) td) { background: color-mix(in srgb, var(--fg) 3.5%, transparent); }
  .md :global(td) { overflow-wrap: normal; min-width: 4ch; }

  .more { all: unset; cursor: pointer; display: block; margin-top: 8px; font-size: 12.5px; font-weight: 600; color: var(--accent); }
  .more:hover { text-decoration: underline; }
</style>
