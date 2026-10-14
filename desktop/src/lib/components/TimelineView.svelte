<script lang="ts">
  // omp's transcript, rendered like its TUI (same rules as the iPhone app).
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import type { Timeline, ToolCall } from "../api";
  import { t } from "../i18n";

  let { timeline, onAnswer }: { timeline: Timeline; onAnswer: (index: number, count: number) => void } = $props();

  const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string);
  const prose = (s: string) =>
    s.split("\n").filter((l, i, all) => l.trim() && !l.trim().startsWith("```")).join("\n");
  const short = (p?: string) => (p ?? "").replace(/^\/home\/[^/]+/, "~");
  const title = (n: string) => (n.startsWith("mcp__") ? n.split("__").pop()! : n.charAt(0).toUpperCase() + n.slice(1));
  const wall = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(2)}s`);

  // consecutive reads collapse into one "Read (n)" block
  function pieces(calls: ToolCall[]) {
    const out: ({ reads: ToolCall[] } | { call: ToolCall })[] = [];
    for (const c of calls.filter((c) => c.name !== "todo")) {
      const last = out.at(-1);
      if (c.name === "read" && last && "reads" in last) last.reads.push(c);
      else if (c.name === "read") out.push({ reads: [c] });
      else out.push({ call: c });
    }
    return out;
  }
  let openThinking = $state<Record<string, boolean>>({});
</script>

<div class="tl">
  {#each timeline.items as item (item.id)}
    {#if item.k === "user"}
      <div class="user">{item.text}</div>
    {:else if item.k === "thinking"}
      <button class="thinking" class:open={openThinking[item.id]} onclick={() => (openThinking[item.id] = !openThinking[item.id])}>
        {prose(item.text)}
      </button>
    {:else if item.k === "text"}
      <div class="md">{@html md(item.text)}</div>
    {:else if item.k === "tools"}
      {#each pieces(item.calls) as p}
        {#if "reads" in p}
          <div class="line mono">
            {#if p.reads.length === 1}
              <span class:err={p.reads[0].status === "error"}>{p.reads[0].status === "running" ? "⣾" : "●"}</span>
              <b>Read</b> <span class="acc">{short(p.reads[0].detail)}</span>
            {:else}
              <span>•</span> <b>Read</b> <span class="dim">({p.reads.length})</span>
              {#each p.reads as r, i}
                <div class="tree"><span class="dim">{i === p.reads.length - 1 ? "└─" : "├─"}</span> <span class="acc">{short(r.detail)}</span></div>
              {/each}
            {/if}
          </div>
        {:else}
          {@const c = p.call}
          {#if c.name === "bash" || c.name === "eval"}
            <div class="card mono {c.status}">
              {#if c.name === "eval"}<div><span class="acc2">•</span> <b>{c.detail ?? "Eval"}</b></div>
              {:else}<div class="cmd"><span class="dim">$ </span>{c.detail}</div>{/if}
              {#if c.out?.length}
                <hr />
                {#if (c.outTotal ?? 0) > c.out.slice(-6).length}
                  <div class="dim">… ({(c.outTotal ?? 0) - c.out.slice(-6).length} earlier lines)</div>
                {/if}
                <pre class:err={c.status === "error"}>{c.out.slice(-6).join("\n")}</pre>
              {:else if c.status === "error" && c.result}<pre class="err">{c.result}</pre>{/if}
              <div class="dim">
                {#if c.status === "running"}<span class="spin">⣾</span> {t("arbeitet")}
                {:else}⟨{[c.ms !== undefined ? `Wall: ${wall(c.ms)}` : "", c.exit !== undefined ? `Exit: ${c.exit}` : "", c.bg ? `Backgrounded: ${c.bg}` : ""].filter(Boolean).join(" | ")}⟩{/if}
              </div>
            </div>
          {:else if ["edit", "write", "task", "web_search"].includes(c.name)}
            <div class="card mono muted-border {c.status}">
              <span class="acc2">{c.status === "error" ? "✘" : c.status === "running" ? "⣾" : "✎"}</span>
              <b>{title(c.name)}:</b> <span class="acc2">{short(c.detail)}</span>
              {#if (c.add ?? 0) + (c.del ?? 0) > 0}
                <span class="dim">⟦</span><span class="ok">+{c.add ?? 0}</span><span class="dim">/</span><span class="err">-{c.del ?? 0}</span><span class="dim">⟧</span>
              {/if}
              {#if c.status === "error" && c.result}<pre class="err">{c.result}</pre>{/if}
            </div>
          {:else}
            <div class="line mono">
              <span class:err={c.status === "error"}>{c.status === "running" ? "⣾" : c.status === "error" ? "✘" : "•"}</span>
              <b>{title(c.name)}</b>{#if c.detail}<span class="muted">: {c.detail}</span>{/if}
              {#if c.result && c.status !== "error"}<span class="dim">  {c.result}</span>{/if}
              {#if c.path}<span class="dim"> · in {short(c.path)}</span>{/if}
              {#if c.status === "error" && c.result}<div class="err">{c.result}</div>{/if}
            </div>
          {/if}
        {/if}
      {/each}
    {:else if item.k === "ask"}
      <div class="card ask" class:pending={item.pending}>
        <div class="mono"><span class="acc2">?</span> <b>{item.pending ? t("Ask – omp wartet auf dich") : "Ask"}</b></div>
        <div>{item.question}</div>
        {#each item.options as opt, i}
          <button class="opt" disabled={!item.pending} onclick={() => onAnswer(i, item.options.length)}>
            {item.answer?.includes(opt) ? "◉" : "○"} {opt}
          </button>
        {/each}
        {#if item.answer}<div class="mono ok">✔ {item.answer}</div>{/if}
      </div>
    {:else if item.k === "end"}
      {#if item.status !== "done"}<div class="mono err">{item.status === "aborted" ? "⏹" : `Error: ${item.error ?? ""}`}</div>{/if}
    {:else if item.k === "info"}
      <div class="info">{item.text}</div>
    {/if}
  {/each}
</div>

<style>
  .tl { display: flex; flex-direction: column; gap: 12px; }
  .user { background: color-mix(in srgb, var(--orange) 11%, transparent); border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; }
  .thinking { all: unset; cursor: pointer; color: var(--muted); font-style: italic; white-space: pre-wrap;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .thinking.open { -webkit-line-clamp: unset; display: block; }
  .md :global(pre) { background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 10px; border-radius: 8px; overflow-x: auto; }
  .md :global(code) { font-family: var(--mono); font-size: 0.9em; }
  .md :global(:not(pre) > code) { background: color-mix(in srgb, var(--fg) 8%, transparent); padding: 1px 4px; border-radius: 4px; }
  .md :global(table) { border-collapse: collapse; }
  .md :global(td), .md :global(th) { border: 1px solid var(--border); padding: 4px 8px; }
  .md :global(p) { margin: 0 0 8px; }
  .card { border: 1px solid color-mix(in srgb, var(--dim) 70%, transparent); border-radius: 10px; padding: 10px 12px;
    background: var(--raised); font-size: 12.5px; }
  .card.running { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .card.error { border-color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
  .muted-border { border-color: var(--border); }
  .cmd { white-space: pre-wrap; word-break: break-all; max-height: 4.5em; overflow: hidden; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 6px 0; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--muted); font-family: var(--mono); }
  .line { font-size: 12.5px; padding: 0 4px; }
  .tree { padding-left: 14px; }
  .acc { color: var(--orange); }
  .acc2 { color: var(--orange); }
  .ok { color: var(--green); }
  .err { color: var(--red); }
  .info { text-align: center; color: var(--dim); font-size: 12px; }
  .ask.pending { border-color: var(--yellow); }
  .opt { display: block; width: 100%; text-align: left; margin-top: 6px; background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 10px; }
  .opt:disabled { cursor: default; opacity: 0.8; }
  .spin { display: inline-block; animation: spin 0.8s steps(8) infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
