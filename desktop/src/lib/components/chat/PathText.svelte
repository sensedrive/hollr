<script lang="ts">
  // A file path in a tool card: a click on the path text opens the file preview (as a path link through `onLink`),
  // without also folding the card around it. Selecting the text to copy it stays selecting. No `onLink`: plain text.
  import type { Snippet } from "svelte";
  import { pathHref } from "../../paths";

  let { path, line, onLink, class: cls = "", children }: {
    /** what the server resolves: absolute, `~/…` or relative to the pane's folder */
    path: string;
    line?: number;
    onLink?: (url: string) => void;
    class?: string;
    children: Snippet;
  } = $props();

  function open(e: Event) {
    e.stopPropagation();
    if (window.getSelection()?.toString()) return;
    onLink?.(pathHref(path, line));
  }
</script>

{#if onLink && path}
  <span class="fpath {cls}" role="link" tabindex="0" title={path} onclick={open}
    onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(e); } }}>{@render children()}</span>
{:else}
  <span class={cls}>{@render children()}</span>
{/if}
