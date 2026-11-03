<script lang="ts">
  // task / subagent: who ran it, how many tool calls it made and how long, its final answer as Markdown
  // (folded to its first line until opened).
  import type { ToolCall } from "../../api";
  import { duration, toolIcon, toolTitle } from "../../agent";
  import { t } from "../../i18n";
  import Markdown from "../Markdown.svelte";
  import Glyph from "./Glyph.svelte";

  let { c, tip, onLink, copy }: { c: ToolCall; tip: string; onLink?: (url: string) => void; copy: (s: string) => void } = $props();

  let open = $state(false);
  const answer = $derived(c.sub?.answer?.trim() ?? "");
  /** first prose line of the answer (headings only as fallback), Markdown marks stripped – the folded preview */
  const preview = $derived.by(() => {
    const lines = answer.split("\n").filter((l) => l.trim() && !l.trim().startsWith("```"));
    const line = lines.find((l) => !/^\s*#/.test(l)) ?? lines[0] ?? "";
    return line.replace(/^[#>*\-\s|`]+/, "").replace(/\*\*|`/g, "").trim();
  });
  const toggle = () => {
    if (answer && !window.getSelection()?.toString()) open = !open;
  };
</script>

<div class="frame soft {c.status}" title={tip}>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex (role/tabindex only while there is an answer) -->
  <div class="hrow mid" class:click={!!answer} onclick={toggle} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
    role={answer ? "button" : undefined} tabindex={answer ? 0 : undefined} aria-expanded={answer ? open : undefined}>
    <Glyph status={c.status} ok={toolIcon(c.name)} color="var(--orange)" />
    <span class="grow clamp2 sel"><b>{toolTitle(c.name)}</b>{#if c.detail}<span class="acc">{` ${c.detail}`}</span>{/if}</span>
    {#if c.sub?.agent}<span class="chip">{c.sub.agent}</span>{/if}
    {#if c.sub?.calls !== undefined}<span class="dim nowrap">{t("{n} Aufrufe", { n: c.sub.calls })}</span>{/if}
    {#if c.ms !== undefined}<span class="dim nowrap">{duration(c.ms)}</span>{/if}
    {#if answer}<span class="dim">{open ? "▾" : "▸"}</span>{/if}
  </div>
  {#if c.label && c.label !== c.detail}<div class="muted clamp2 sel">{c.label}</div>{/if}
  {#if c.status === "error" && c.result}<div class="err clamp4 sel">{c.result}</div>{/if}
  {#if answer}
    {#if open}
      <div class="answer">
        <Markdown text={answer} plain {onLink} />
        <div class="hrow"><button class="act" onclick={() => copy(answer)}>⧉ {t("Antwort kopieren")}</button></div>
      </div>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="preview click" onclick={toggle}><span class="dim">{"↳ "}</span><span class="muted">{preview}</span></div>
    {/if}
  {/if}
</div>

<style>
  .answer { border-top: 1px solid var(--border); padding-top: 8px; font-family: -apple-system, system-ui, sans-serif; font-size: 13px;
    display: flex; flex-direction: column; gap: 6px; }
  .preview { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
