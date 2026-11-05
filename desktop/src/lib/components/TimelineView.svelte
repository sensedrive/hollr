<script lang="ts">
  // The agent's transcript (omp or Claude Code), rendered like omp's TUI but richer (rules shared with the iPhone
  // app, TimelineViews.swift): messages, folded thinking, and tool calls as cards (components/chat/*). Given the
  // element it scrolls in, it brings the find bar (⌘F) and the overview ruler, floating over that element.
  import type { AskPick, Timeline } from "../api";
  import { lang, t } from "../i18n";
  import { thinkingProse } from "../agent";
  import { chatView, finishedJobs, jobCalls, jobViews } from "../chatTools";
  import { findUnits, itemKind } from "../chatFind";
  import { clock, fullTime, stampedIds } from "../msgTimes";
  import AskCard from "./AskCard.svelte";
  import Markdown from "./Markdown.svelte";
  import ToolCalls from "./chat/ToolCalls.svelte";
  import MsgActions from "./MsgActions.svelte";
  import ChatFind from "./chat/ChatFind.svelte";
  import ChatRuler from "./chat/ChatRuler.svelte";
  import { provideReveal } from "./chat/reveal";

  let { timeline, root, onAnswer, onLink, onResend, scroller, overview = true, onFinding }: {
    timeline: Timeline;
    /** the space folder (pane cwd): tool paths under it show relative */
    root?: string;
    /** answers omp's question (ask id, one pick per question); false = not sent */
    onAnswer: (ask: string, picks: AskPick[]) => Promise<boolean>;
    onLink?: (url: string) => void;
    /** sends one of your prompts again (its hover action); absent = no such action */
    onResend?: (text: string) => void;
    /** the element the chat scrolls in: with it come ⌘F find and the overview ruler, laid over it – its parent
     *  must be positioned, and it should keep room on the right for the ruler (RULER_W) */
    scroller?: HTMLElement;
    /** the overview ruler at the right edge (settings.chatOverview) */
    overview?: boolean;
    /** the find bar opened / closed – the host stops sticking to the bottom meanwhile, so hits stay put */
    onFinding?: (open: boolean) => void;
  } = $props();

  /** visible items, tool calls grouped into pieces, todo history – derived once per timeline, not per render */
  const view = $derived(chatView(timeline.items));
  const items = $derived(view.items);
  /** background jobs: the call that started each, the running ones with their intents (wait and bash cards) */
  const starts = $derived(jobCalls(timeline.items));
  const jobs = $derived(jobViews(timeline, starts));
  /** items that show their time (user messages, the start of each reply) */
  const stamped = $derived(stampedIds(items));
  let openThinking = $state<Record<string, boolean>>({});

  // ---- find & overview
  /** the ruler's width – AgentView keeps this much room right of the chat */
  const RULER_W = 56;
  /** folded units the find bar opened (chat/reveal.ts) */
  let reveal = $state.raw(new Set<string>());
  provideReveal({ has: (key) => reveal.has(key) });
  /** searched only while the bar is open ($derived is lazy) */
  const units = $derived(findUnits(view, thinkingProse));
  let matches = $state.raw<Range[]>([]);
  let current = $state(-1);
  let list: HTMLDivElement | undefined = $state();
  let marks: HTMLDivElement | undefined = $state();
  let find: ChatFind | undefined = $state();

  /** Opens the find bar (the ⋯ menu's "Im Chat suchen"). */
  export const openFind = () => find?.open();

  /** The bar and the ruler float over the scroller – moved into its positioned parent, outside the scrolled content. */
  function overScroller(deck: HTMLElement) {
    const sc = scroller;
    if (!sc?.parentElement) return;
    sc.parentElement.append(deck);
    const place = () => {
      Object.assign(deck.style, { top: `${sc.offsetTop}px`, left: `${sc.offsetLeft}px`, width: `${sc.offsetWidth}px`, height: `${sc.clientHeight}px` });
    };
    const ro = new ResizeObserver(place);
    ro.observe(sc);
    place();
    return () => {
      ro.disconnect();
      deck.remove();
    };
  }
</script>

{#snippet stamp(at: number | undefined, id: string, alone = false)}
  {#if at !== undefined && stamped.has(id)}<time class="stamp" class:alone datetime={new Date(at).toISOString()} title={fullTime(at, lang())}>{clock(at, lang())}</time>{/if}
{/snippet}

<div class="tl" bind:this={list}>
  <!-- every item's root carries `data-find` (the find bar searches it) and `data-ov` (its colour in the ruler) -->
  {#each items as item (item.id)}
    {#if item.k === "user"}
      <div class="msg" data-item={item.id} data-find={item.id} data-ov="user">
        {@render stamp(item.at, item.id)}
        <div class="user" class:voice={item.source === "voice"}>
          {#if item.source === "voice"}<span class="src" title={t("gesprochen")}>🎙</span>{/if}{item.text}<MsgActions text={item.text} {onResend} side="start" />
        </div>
      </div>
    {:else if item.k === "thinking"}
      {@const prose = thinkingProse(item.text)}
      {@render stamp(item.at, item.id, true)}
      {#if prose && (openThinking[item.id] || reveal.has(item.id))}
        <div class="thinking-open" data-find={item.id} data-ov="think">
          <button class="th-head" onclick={() => (openThinking[item.id] = false)}>✻ {t("Gedanken")} <span class="dim">▴</span></button>
          <div class="th-body">{prose}</div>
        </div>
      {:else if prose}
        <button class="thinking" title={t("Gedanken aufklappen")} onclick={() => (openThinking[item.id] = true)} data-find={item.id} data-ov="think">{prose}</button>
      {/if}
    {:else if item.k === "text"}
      <div class="msg" data-item={item.id} data-find={item.id} data-ov="agent">
        {@render stamp(item.at, item.id)}
        <Markdown text={item.text} plain {onLink} />
      </div>
    {:else if item.k === "tools"}
      {@render stamp(item.at, item.id, true)}
      <div data-find={item.id} data-ov={itemKind(item)}>
        <ToolCalls pieces={view.pieces.get(item.id) ?? []} todo={view.todo} {root} {jobs} jobCalls={starts} {onLink} />
      </div>
    {:else if item.k === "ask"}
      <div class="msg" data-item={item.id} data-find={item.id} data-ov="ask">
        {@render stamp(item.at, item.id)}
        <AskCard {item} {onAnswer} agent={timeline.agent === "claude" ? "Claude" : "omp"} />
      </div>
    {:else if item.k === "end"}
      {#if item.status === "aborted"}<div class="mono small warn" data-find={item.id} data-ov="err">⏹ {t("Abgebrochen")}</div>
      {:else if item.status !== "done"}<div class="mono small err clamp8" data-find={item.id} data-ov="err">Error: {item.error ?? t("unbekannt")}</div>{/if}
    {:else if item.k === "info"}
      {@const done = finishedJobs(item.text, starts)}
      {#if done}<div class="info" title={item.text} data-find={item.id} data-ov="info"><span class="ok">✓</span> {t("Hintergrund-Job fertig")} · {done.join(", ")}</div>
      {:else}<div class="info" data-find={item.id} data-ov="info">{item.text}</div>{/if}
    {/if}
  {/each}
  {#if scroller}<div class="findmarks" bind:this={marks} aria-hidden="true"></div>{/if}
</div>

{#if scroller && list && marks}
  <!-- stays here as the block's node; its child moves over the scroller (overScroller) -->
  <div hidden>
    <div class="deck" style:--ruler-w="{overview ? RULER_W : 0}px" {@attach overScroller}>
      <ChatFind bind:this={find} {scroller} root={list} {marks} {units} bind:reveal bind:matches bind:current {onFinding} />
      {#if overview}<ChatRuler {scroller} root={list} {matches} {current} onPick={(i) => find?.show(i)} />{/if}
    </div>
  </div>
{/if}

<style>
  /* positioned: the ruler measures items by their offsets in here, the fallback find boxes are drawn in here */
  .tl { display: flex; flex-direction: column; gap: 12px; position: relative; }
  .findmarks { position: absolute; inset: 0; pointer-events: none; }
  .deck { position: absolute; z-index: 2; pointer-events: none; }
  .user { position: relative; background: color-mix(in srgb, var(--orange) 11%, transparent); border-radius: 10px; padding: 10px 12px;
    white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .src { font-size: 11px; margin-right: 6px; opacity: 0.7; }
  .msg { display: flex; flex-direction: column; gap: 3px; min-width: 0; border-radius: 10px; }
  /* the time of a message: quiet, above it; the user's on the right like their bubble */
  .stamp { font-size: 10.5px; color: var(--dim); font-variant-numeric: tabular-nums; padding: 0 4px; user-select: none; cursor: default; }
  .msg:has(> .user) > .stamp { align-self: flex-end; }
  .stamp.alone { margin-bottom: -9px; }
  .thinking { all: unset; cursor: pointer; color: var(--muted); font-style: italic; font-size: 0.95em; white-space: pre-wrap; padding: 0 4px;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .thinking:hover { color: color-mix(in srgb, var(--muted) 70%, var(--fg)); }
  /* open: upright, full contrast and roomy – it is read now, not skimmed */
  .thinking-open { padding: 2px 0 2px 12px; border-left: 2px solid color-mix(in srgb, var(--purple) 45%, transparent); display: flex; flex-direction: column; gap: 4px; }
  .th-head { all: unset; cursor: pointer; align-self: flex-start; font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .th-head:hover { color: var(--fg); }
  .th-body { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; line-height: 1.6; font-size: 0.95em;
    color: color-mix(in srgb, var(--fg) 82%, transparent); max-width: 80ch; }
  .mono { font-family: var(--mono); }
  .clamp8 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; -webkit-line-clamp: 8; line-clamp: 8; }
  .err { color: var(--red); }
  .ok { color: var(--green); }
  .warn { color: var(--yellow); }
  .dim { color: var(--dim); }
  .small { font-size: 12px; }
  .info { text-align: center; color: var(--dim); font-size: 12px; }
</style>
