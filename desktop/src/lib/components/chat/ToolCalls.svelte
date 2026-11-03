<script lang="ts">
  // One tools item of the chat: reads as a compact tree (consecutive reads merged), todo updates as todo cards,
  // every other call as its card (edit diff, bash output, grep hits, subagent answer, links …).
  import type { ToolCall } from "../../api";
  import { duration, shortPath, toolIcon, toolTitle } from "../../agent";
  import { cardKind, parseRange, searchScopes, toolTip, underRoot, type JobView, type Piece, type TodoMark } from "../../chatTools";
  import { t } from "../../i18n";
  import "./tools.css";
  import BashCard from "./BashCard.svelte";
  import EditCard from "./EditCard.svelte";
  import Glyph from "./Glyph.svelte";
  import LinksCard from "./LinksCard.svelte";
  import SearchCard from "./SearchCard.svelte";
  import TaskCard from "./TaskCard.svelte";
  import TodoCard from "./TodoCard.svelte";
  import WaitCard from "./WaitCard.svelte";

  let { pieces, todo, root, jobs, jobCalls, onLink }: {
    pieces: Piece[];
    todo: Map<string, TodoMark>;
    /** the space folder: paths under it show relative */
    root?: string;
    /** the timeline's running background jobs */
    jobs: JobView[];
    /** job id → the call that started it */
    jobCalls: Map<string, ToolCall>;
    onLink?: (url: string) => void;
  } = $props();

  const tip = (c: ToolCall) => toolTip(c, duration);
  const rel = (p?: string) => (p ? (underRoot(p, root) ?? shortPath(p)) : "");
  const copy = (s: string) => void navigator.clipboard.writeText(s).catch(() => {});
  /** "inventory.py · 30 Zeilen" for a whole file, "README.md:10-40 / 120" for a part */
  function readPath(c: ToolCall) {
    const p = rel(c.file ?? c.detail);
    const r = c.range ? parseRange(c.range) : undefined;
    if (!r) return { p, r: c.range ? `:${c.range}` : "" };
    if (r.whole) return { p, r: ` · ${t("{n} Zeilen", { n: r.total ?? r.to })}` };
    return { p, r: `:${r.from}-${r.to}${r.total !== undefined ? ` / ${r.total}` : ""}` };
  }
</script>

<div class="chat-tools">
  {#each pieces as p (p.id)}
    {#if p.kind === "reads"}
      {@const reads = p.calls}
      <div class="line">
        {#if reads.length === 1}
          {@const r = reads[0]!}
          {@const rp = readPath(r)}
          <div class="hrow" title={tip(r)}><Glyph status={r.status} ok="●" /> <b>Read</b> <span class="ellipsis sel"><span class="acc">{rp.p}</span><span class="dim">{rp.r}</span></span></div>
          {#if r.status === "error" && r.result}<div class="err indent clamp3 sel">{r.result}</div>{/if}
        {:else}
          {@const running = reads.find((r) => r.status === "running")}
          <div class="hrow">
            {#if running}<Glyph status="running" ok="" />{:else}<span class:err={reads.some((r) => r.status === "error")}>•</span>{/if}
            <b>Read</b> <span class="dim">({reads.length})</span>
          </div>
          {#each reads as r, i (r.id)}
            {@const rp = readPath(r)}
            <div class="hrow indent" title={tip(r)}>
              <span class="tree">{i === reads.length - 1 ? "└─" : "├─"}</span>
              <span class="ellipsis sel"><span class:acc={r.status !== "error"} class:err={r.status === "error"}>{rp.p}</span><span class="dim">{rp.r}</span></span>
            </div>
            {#if r.status === "error" && r.result}<div class="err indent clamp3 sel">{r.result}</div>{/if}
          {/each}
        {/if}
      </div>
    {:else if p.kind === "todo"}
      {@const mark = todo.get(p.id)}
      {#if mark}<TodoCard calls={p.calls} {mark} tip={tip(p.calls.at(-1)!)} />{/if}
    {:else}
      {@const c = p.call}
      {@const k = cardKind(c)}
      {#if k === "bash"}
        <BashCard {c} {root} tip={tip(c)} {copy} job={c.bg ? jobs.find((j) => j.id === c.bg) : undefined} />
      {:else if k === "edit"}
        <EditCard {c} {root} tip={tip(c)} {copy} />
      {:else if k === "search"}
        <SearchCard {c} {root} tip={tip(c)} />
      {:else if k === "task"}
        <TaskCard {c} tip={tip(c)} {onLink} {copy} />
      {:else if k === "links"}
        <LinksCard {c} tip={tip(c)} {onLink} />
      {:else if k === "wait"}
        <WaitCard {c} tip={tip(c)} {jobs} calls={jobCalls} />
      {:else if k === "compact"}
        <div class="line" title={tip(c)}>
          <div class="hrow">
            <Glyph status={c.status} ok={toolIcon(c.name)} color="var(--muted)" />
            <span class="clamp2 sel"><b>{toolTitle(c.name)}</b><span class="muted">{c.detail ? `: ${c.detail}` : ""}</span><span class="dim">{c.status !== "error" && c.result ? `  ${c.result}` : ""}{c.path ? ` · in ${searchScopes(c.path).map(rel).join(", ")}` : ""}</span></span>
          </div>
          {#if c.status === "error" && c.result}<div class="err indent clamp3 sel">{c.result}</div>{/if}
        </div>
      {:else}
        <div class="line" title={tip(c)}>
          <div class="hrow"><Glyph status={c.status} ok="•" /> <b>{toolTitle(c.name)}</b></div>
          {#if c.detail}<div class="dim ellipsis sel"> └─ {c.detail}</div>{/if}
          {#if c.status === "error" && c.result}<div class="err clamp3 sel">{c.result}</div>{/if}
        </div>
      {/if}
    {/if}
  {/each}
</div>
