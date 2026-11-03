<script lang="ts">
  // web_search / fetch: the query (or URL) and the result links – title plus host, opened through `onLink`
  // (the session view asks: Hollr browser or system browser). More than 5 links fold.
  import type { ToolCall } from "../../api";
  import { toolIcon, toolTitle } from "../../agent";
  import Glyph from "./Glyph.svelte";
  import More from "./More.svelte";

  let { c, tip, onLink }: { c: ToolCall; tip: string; onLink?: (url: string) => void } = $props();

  const PREVIEW = 5;
  let open = $state(false);
  const links = $derived(
    (c.links?.length ? c.links : c.name === "fetch" && c.detail && /^https?:\/\//.test(c.detail) ? [{ title: "", url: c.detail }] : [])
      .map((l) => {
        let host = l.url;
        try { host = new URL(l.url).host.replace(/^www\./, ""); } catch {}
        return { ...l, host };
      }),
  );
  const shown = $derived(open ? links : links.slice(0, PREVIEW));
  const follow = (e: MouseEvent, url: string) => {
    if (!onLink) return;
    e.preventDefault();
    onLink(url);
  };
</script>

<div class="line" title={tip}>
  <div class="hrow">
    <Glyph status={c.status} ok={toolIcon(c.name)} color="var(--muted)" />
    <span class="clamp2 sel"><b>{toolTitle(c.name)}</b>{#if c.detail && !(c.name === "fetch" && links.length === 1 && !links[0]?.title)}<span class="muted">{` ${c.detail}`}</span>{/if}<span class="dim">{c.status !== "error" && c.result ? ` · ${c.result}` : ""}</span></span>
  </div>
  {#if c.status === "error" && c.result}<div class="err indent clamp3 sel">{c.result}</div>{/if}
  {#if shown.length}
    <div class="links">
      {#each shown as l, i (l.url + i)}
        <div class="hrow">
          <span class="tree">{i === shown.length - 1 && (open || links.length <= PREVIEW) ? "└─" : "├─"}</span>
          <a href={l.url} target="_blank" rel="noreferrer" title={l.url} onclick={(e) => follow(e, l.url)}>
            {#if l.title}<span class="ttl">{l.title}</span> <span class="dim">{l.host}</span>{:else}<span class="ttl">{l.url}</span>{/if}
          </a>
        </div>
      {/each}
    </div>
    {#if links.length > PREVIEW}
      <div class="indent"><More {open} hidden={links.length - shown.length} unit="links" ontoggle={() => (open = !open)} /></div>
    {/if}
  {/if}
</div>

<style>
  .links { padding-left: 4px; line-height: 1.55; }
  .tree { flex: none; }
  a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: none; }
  a .ttl { color: var(--blue, var(--accent)); }
  a:hover .ttl { text-decoration: underline; }
</style>
