<script lang="ts">
  // omp's transcript, rendered like its TUI (same rules as the iPhone app, TimelineViews.swift):
  // read/grep/glob as compact lines (consecutive reads merged), bash & edits as framed cards, thinking folded.
  import type { Timeline, ToolCall } from "../api";
  import { t } from "../i18n";
  import { duration, shortPath, thinkingProse, toolIcon, toolTitle, visibleItems } from "../agent";
  import Markdown from "./Markdown.svelte";

  let { timeline, onAnswer, onLink }: {
    timeline: Timeline;
    /** pick option `index` of a pending ask (cursor starts on the first option) */
    onAnswer: (index: number, count: number) => void;
    onLink?: (url: string) => void;
  } = $props();

  type Piece = { reads: ToolCall[]; id: string } | { call: ToolCall; id: string };
  function pieces(calls: ToolCall[]): Piece[] {
    const out: Piece[] = [];
    for (const c of calls) {
      const last = out.at(-1);
      if (c.name === "read" && last && "reads" in last) last.reads.push(c);
      else if (c.name === "read") out.push({ reads: [c], id: `r-${c.id}` });
      else out.push({ call: c, id: c.id });
    }
    return out;
  }

  type Kind = "bash" | "compact" | "header" | "generic";
  function kind(c: ToolCall): Kind {
    if (c.name === "bash" || c.name === "eval") return "bash";
    if (["grep", "glob", "find", "todo", "wait"].includes(c.name) || c.name.startsWith("mcp__")) return "compact";
    if (["edit", "write", "task", "web_search"].includes(c.name)) return "header";
    return "generic";
  }

  const items = $derived(visibleItems(timeline));
  let openThinking = $state<Record<string, boolean>>({});
  let openTool = $state<Record<string, boolean>>({});
  const tip = (c: ToolCall) => [c.label, c.ms !== undefined ? duration(c.ms) : ""].filter(Boolean).join(" · ");

  function compactMeta(c: ToolCall) {
    const parts: string[] = [];
    if (c.status !== "error" && c.result) parts.push(c.result);
    if (c.path) parts.push(`in ${shortPath(c.path)}`);
    return parts.length ? `  ${parts.join(" · ")}` : "";
  }
  function bashFooter(c: ToolCall) {
    return [
      c.ms !== undefined ? `Wall: ${(c.ms / 1000).toFixed(2)}s` : "",
      c.exit !== undefined ? `Exit: ${c.exit}` : "",
      c.bg ? `Backgrounded: ${c.bg}` : "",
    ].filter(Boolean).join(" | ");
  }
  const copy = (s?: string) => s && navigator.clipboard.writeText(s).catch(() => {});
</script>

{#snippet glyph(c: ToolCall, ok: string, okColor: string)}
  {#if c.status === "running"}<span class="braille acc"></span>
  {:else if c.status === "error"}<span class="err">✘</span>
  {:else}<span style:color={okColor}>{ok}</span>{/if}
{/snippet}

<div class="tl">
  {#each items as item (item.id)}
    {#if item.k === "user"}
      <div class="user" class:voice={item.source === "voice"}>
        {#if item.source === "voice"}<span class="src" title={t("gesprochen")}>🎙</span>{/if}{item.text}
      </div>
    {:else if item.k === "thinking"}
      {@const prose = thinkingProse(item.text)}
      {#if prose}
        <button class="thinking" class:open={openThinking[item.id]} onclick={() => (openThinking[item.id] = !openThinking[item.id])}>{prose}</button>
      {/if}
    {:else if item.k === "text"}
      <Markdown text={item.text} plain {onLink} />
    {:else if item.k === "tools"}
      <div class="tools">
        {#each pieces(item.calls) as p (p.id)}
          {#if "reads" in p}
            {@const reads = p.reads}
            <div class="line mono">
              {#if reads.length === 1}
                {@const r = reads[0]!}
                <div class="hrow" title={tip(r)}>{@render glyph(r, "●", "var(--fg)")} <b>Read</b> <span class="acc ellipsis">{shortPath(r.detail)}</span></div>
                {#if r.status === "error" && r.result}<div class="err indent clamp3">{r.result}</div>{/if}
              {:else}
                {@const running = reads.find((r) => r.status === "running")}
                <div class="hrow">
                  {#if running}{@render glyph(running, "", "")}{:else}<span class:err={reads.some((r) => r.status === "error")}>•</span>{/if}
                  <b>Read</b> <span class="dim">({reads.length})</span>
                </div>
                {#each reads as r, i (r.id)}
                  <div class="hrow indent" title={tip(r)}>
                    <span class="dim">{i === reads.length - 1 ? "└─" : "├─"}</span>
                    <span class="ellipsis" class:acc={r.status !== "error"} class:err={r.status === "error"}>{shortPath(r.detail)}</span>
                  </div>
                {/each}
              {/if}
            </div>
          {:else}
            {@const c = p.call}
            {@const k = kind(c)}
            {#if k === "bash"}
              {@const open = !!openTool[c.id]}
              {@const out = c.out ?? []}
              {@const tail = open ? out : out.slice(-4)}
              {@const hidden = (c.outTotal ?? out.length) - tail.length}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="frame click mono {c.status}" class:open onclick={(e) => { if (!window.getSelection()?.toString()) openTool[c.id] = !open; e.stopPropagation(); }} title={open ? "" : t("Klicken für mehr Ausgabe")}>
                {#if c.name === "eval"}
                  <div class="hrow">{@render glyph(c, "•", "var(--orange)")} <b class="ellipsis">{c.detail ?? "Eval"}</b></div>
                {:else}
                  <div class="cmd" class:clamp3={!open}><span class="dim">$ </span>{c.detail ?? ""}</div>
                  <button class="copy" title={t("Befehl kopieren")} onclick={(e) => { e.stopPropagation(); copy(c.detail); }}>⧉</button>
                {/if}
                {#if out.length}
                  <hr />
                  {#if hidden > 0}
                    <div class="dim">… ({hidden} earlier lines, showing {tail.length} of {c.outTotal ?? out.length})</div>
                  {/if}
                  <pre class:err={c.status === "error"} class:clamp8={!open}>{tail.join("\n")}</pre>
                {:else if c.status === "error" && c.result}
                  <pre class="err" class:clamp4={!open}>{c.result}</pre>
                {/if}
                {#if c.status === "running"}
                  <div class="hrow"><span class="braille acc"></span> <span class="muted">{t("läuft")}</span></div>
                {:else if bashFooter(c)}
                  <div class:err={c.exit !== undefined} class:dim={c.exit === undefined}>⟨{bashFooter(c)}⟩</div>
                {/if}
                {#if open && c.path}<div class="dim">in {shortPath(c.path)}</div>{/if}
              </div>
            {:else if k === "header"}
              <div class="frame mono muted-border {c.status}" title={tip(c)}>
                <div class="hrow">
                  {@render glyph(c, toolIcon(c.name), "var(--orange)")}
                  <span class="grow clamp2"><b>{toolTitle(c.name)}</b>{#if c.detail}<span class="acc">: {shortPath(c.detail)}</span>{/if}</span>
                  {#if (c.add ?? 0) + (c.del ?? 0) > 0}
                    <span class="nowrap"><span class="dim">⟦</span><span class="ok">+{c.add ?? 0}</span><span class="dim">/</span><span class="err">-{c.del ?? 0}</span><span class="dim">⟧</span></span>
                  {/if}
                </div>
                {#if c.status === "error" && c.result}<div class="err clamp4">{c.result}</div>{/if}
              </div>
            {:else if k === "compact"}
              <div class="line mono" title={tip(c)}>
                <div class="hrow top">
                  {@render glyph(c, toolIcon(c.name), "var(--muted)")}
                  <span class="clamp2"><b>{toolTitle(c.name)}</b><span class="muted">{c.detail ? `: ${c.detail}` : ""}</span><span class="dim">{compactMeta(c)}</span></span>
                </div>
                {#if c.status === "error" && c.result}<div class="err indent clamp3">{c.result}</div>{/if}
              </div>
            {:else}
              <div class="line mono" title={tip(c)}>
                <div class="hrow">{@render glyph(c, "•", "var(--fg)")} <b>{toolTitle(c.name)}</b></div>
                {#if c.detail}<div class="dim ellipsis"> └─ {c.detail}</div>{/if}
                {#if c.status === "error" && c.result}<div class="err clamp3">{c.result}</div>{/if}
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    {:else if item.k === "ask"}
      <div class="ask" class:pending={item.pending}>
        <div class="mono hrow"><b class="acc">?</b> <b class="small" class:warn={item.pending}>{item.pending ? t("Ask – omp wartet auf dich") : t("Ask")}</b></div>
        <div class="q">{item.question}</div>
        {#each item.options as opt, i}
          <button class="opt" class:live={item.pending} disabled={!item.pending} onclick={() => onAnswer(i, item.options.length)}>
            <span class="acc">{item.answer?.includes(opt) ? "◉" : "○"}</span> {opt}
          </button>
        {/each}
        {#if item.answer}<div class="mono small" class:ok={item.answer !== "abgebrochen"} class:warn={item.answer === "abgebrochen"}>✔ {item.answer}</div>{/if}
      </div>
    {:else if item.k === "end"}
      {#if item.status === "aborted"}<div class="mono small warn">⏹ {t("Abgebrochen")}</div>
      {:else if item.status !== "done"}<div class="mono small err clamp8">Error: {item.error ?? t("unbekannt")}</div>{/if}
    {:else if item.k === "info"}
      <div class="info">{item.text}</div>
    {/if}
  {/each}
</div>

<style>
  .tl { display: flex; flex-direction: column; gap: 12px; }
  .tools { display: flex; flex-direction: column; gap: 10px; }
  .user { background: color-mix(in srgb, var(--orange) 11%, transparent); border-radius: 10px; padding: 10px 12px;
    white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .src { font-size: 11px; margin-right: 6px; opacity: 0.7; }
  .thinking { all: unset; cursor: pointer; color: var(--muted); font-style: italic; font-size: 0.95em; white-space: pre-wrap; padding: 0 4px;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .thinking:hover { color: color-mix(in srgb, var(--muted) 70%, var(--fg)); }
  .thinking.open { -webkit-line-clamp: unset; line-clamp: unset; display: block; user-select: text; }
  .mono { font-family: var(--mono); }
  .line { font-size: 12px; padding: 0 4px; line-height: 1.5; }
  .hrow { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .hrow.top { align-items: flex-start; }
  .indent { padding-left: 14px; }
  .frame { position: relative; border: 1px solid color-mix(in srgb, var(--dim) 70%, transparent); border-radius: 10px; padding: 10px 12px;
    background: var(--raised); font-size: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .frame.muted-border { border-color: color-mix(in srgb, var(--border) 60%, transparent); }
  .frame.running { border-color: color-mix(in srgb, var(--orange) 70%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .frame.error { border-color: color-mix(in srgb, var(--red) 80%, transparent); background: color-mix(in srgb, var(--red) 14%, transparent); }
  .frame.click { cursor: pointer; }
  .frame.click.open { cursor: default; }
  .cmd { white-space: pre-wrap; word-break: break-all; padding-right: 22px; user-select: text; }
  .copy { all: unset; cursor: pointer; position: absolute; top: 7px; right: 9px; color: var(--dim); opacity: 0; font-size: 13px; }
  .frame:hover .copy { opacity: 1; }
  .copy:hover { color: var(--fg); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 0; width: 100%; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--muted); font-family: var(--mono); font-size: inherit; user-select: text; }
  .frame.open pre { max-height: 60vh; overflow: auto; }
  .clamp2, .clamp3, .clamp4, .clamp8 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .clamp2 { -webkit-line-clamp: 2; line-clamp: 2; }
  .clamp3 { -webkit-line-clamp: 3; line-clamp: 3; }
  .clamp4 { -webkit-line-clamp: 4; line-clamp: 4; }
  .clamp8 { -webkit-line-clamp: 8; line-clamp: 8; }
  .grow { flex: 1; min-width: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; direction: ltr; }
  .nowrap { white-space: nowrap; }
  .acc { color: var(--orange); }
  .ok { color: var(--green); }
  .err { color: var(--red); }
  .warn { color: var(--yellow); }
  .dim { color: var(--dim); }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .info { text-align: center; color: var(--dim); font-size: 12px; }
  .ask { border: 1px solid color-mix(in srgb, var(--border) 60%, transparent); border-radius: 10px; padding: 12px; background: var(--raised);
    display: flex; flex-direction: column; gap: 8px; }
  .ask.pending { border-color: color-mix(in srgb, var(--yellow) 70%, transparent); }
  .q { white-space: pre-wrap; user-select: text; }
  .opt { all: unset; display: flex; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 13.5px; cursor: default; }
  .opt.live { cursor: pointer; background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .opt.live:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
</style>
