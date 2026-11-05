<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // Above the terminal: omp's TUI shows no times, so the last few messages with time and who said them,
  // and since when the current turn runs. Folded it keeps the newest line; a click opens that message in the chat.
  import type { Timeline } from "../api";
  import { lang, t } from "../i18n";
  import { clock, fullTime, recentSaid, type Said } from "../msgTimes";

  let { timeline, working, agent, onPick }: {
    timeline: Timeline;
    working: boolean;
    /** the agent's name ("omp") for its lines */
    agent: string;
    /** show this message in the chat */
    onPick: (id: string) => void;
  } = $props();

  const KEY = "hollr.agent.timeStrip";
  let closed = $state(localStorage.getItem(KEY) === "closed");
  function toggle() {
    closed = !closed;
    try {
      localStorage.setItem(KEY, closed ? "closed" : "open");
    } catch {}
  }

  const said = $derived(recentSaid(timeline.items, 4));
  const shown = $derived(closed ? said.slice(-1) : said);
  const since = $derived(working ? timeline.turnStartedAt : undefined);
  const who = (s: Said) => (s.who === "you" ? t("Du") : s.who === "peer" ? t("Agent") : agent);
</script>

{#if said.length || since !== undefined}
  <div class="timestrip mono" class:closed>
    <div class="rows">
      {#each shown as s (s.id)}
        <button class="row" title="{fullTime(s.at, lang())} · {t('Im Chat zeigen')}" onclick={() => onPick(s.id)}>
          <span class="time">{clock(s.at, lang())}</span>
          <span class="who {s.who}">{who(s)}{#if s.voice} <Icon name="🎙" size={15} />{/if}</span>
          <span class="text">{s.text}</span>
        </button>
      {/each}
    </div>
    <div class="side">
      {#if since !== undefined}
        <span class="since" title={fullTime(since, lang())}><span class="braille"></span> {t("arbeitet seit {time}", { time: clock(since, lang()) })}</span>
      {/if}
      <button class="tog" title={closed ? t("Verlauf mit Zeiten aufklappen") : t("Verlauf mit Zeiten einklappen")} onclick={toggle}><Icon name={closed ? "▾" : "▴"} size={13} /></button>
    </div>
  </div>
{/if}

<style>
  .timestrip { display: flex; align-items: flex-start; gap: 10px; font-size: 11.5px; line-height: 1.55; padding: 4px 6px 4px 8px;
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: 8px; background: var(--raised); min-width: 0; }
  .rows { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .row { all: unset; cursor: pointer; display: flex; gap: 8px; min-width: 0; border-radius: 4px; padding: 0 4px; }
  .row:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }
  .row:focus-visible { outline: 1px solid var(--accent); }
  .time { flex: none; color: var(--dim); font-variant-numeric: tabular-nums; }
  .who { flex: none; min-width: 3.2em; color: var(--muted); }
  .who.you { color: var(--orange); }
  .text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: color-mix(in srgb, var(--fg) 80%, transparent); }
  .side { flex: none; display: flex; align-items: center; gap: 8px; }
  .since { color: var(--orange); white-space: nowrap; }
  .tog { all: unset; cursor: pointer; color: var(--dim); padding: 0 4px; border-radius: 4px; }
  .tog:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 7%, transparent); }
</style>
