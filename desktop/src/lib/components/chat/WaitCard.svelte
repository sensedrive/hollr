<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // wait: like omp's "ℹ waiting on 1 job" – the intent, which jobs it waits on (while running: the running jobs, they
  // are what a wait waits for) and, once back, how long it waited and how each reported job ended.
  import type { ToolCall } from "../../api";
  import { duration, hashId, toolTitle } from "../../agent";
  import { jobOutcome, jobView, type JobView } from "../../chatTools";
  import { t } from "../../i18n";
  import Glyph from "./Glyph.svelte";

  let { c, tip, jobs, calls }: {
    c: ToolCall;
    tip: string;
    /** the timeline's running jobs (with intents) */
    jobs: JobView[];
    /** job id → the call that started it */
    calls: Map<string, ToolCall>;
  } = $props();

  const running = $derived(c.status === "running");
  const intent = $derived(c.label && c.label !== c.name ? c.label : undefined);
  type Row = JobView & { outcome?: "done" | "failed" | "running"; ms?: number };
  const rows = $derived.by((): Row[] => {
    if (running) return jobs;
    return (c.waited ?? []).map((w) => ({ ...jobView(w, calls.get(w.id)), outcome: jobOutcome(w.status), ms: w.ms }));
  });
  const summary = $derived(
    running
      ? rows.length ? t("wartet auf {jobs}", { jobs: rows.length === 1 ? t("1 Job") : t("{n} Jobs", { n: rows.length }) }) : ""
      : c.ms !== undefined ? duration(c.ms) : "",
  );

  // running rows show their run time – tick only while this wait runs
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
</script>

<div class="line" title={tip}>
  <div class="hrow">
    <Glyph status={c.status} ok="ℹ" color="var(--cyan)" />
    <span class="clamp2 sel"><b>{toolTitle(c.name)}</b>{#if intent}<span class="muted">{` ${intent}`}</span>{/if}{#if summary}<span class="dim">{` · ${summary}`}</span>{/if}</span>
  </div>
  {#if c.status === "error" && c.result}<div class="err indent clamp3 sel">{c.result}</div>{/if}
  {#each rows as r, i (r.id)}
    <div class="hrow job" title={r.full ?? r.title}>
      <span class="tree">{i === rows.length - 1 ? "└─" : "├─"}</span>
      {#if !hashId(r.id)}<span class="id">{r.id}</span>{/if}
      <span class="ellipsis grow"><span class="fgs">{r.title}</span>{#if r.command}<span class="dim gap">{r.command}</span>{/if}</span>
      {#if r.outcome === "done"}<span class="ok nowrap"><Icon name="✓" size={15} /> {t("fertig")}</span>
      {:else if r.outcome === "failed"}<span class="err nowrap"><Icon name="✘" size={15} /> {t("fehlgeschlagen")}</span>
      {:else if r.outcome === "running"}<span class="warn nowrap">{t("läuft weiter")}</span>{/if}
      {#if r.ms !== undefined}<span class="dim nowrap">{duration(r.ms)}</span>
      {:else if running && r.startedAt}<span class="dim nowrap">{duration(now - r.startedAt)}</span>{/if}
    </div>
  {/each}
</div>

<style>
  .job { padding-left: 4px; }
  .id { color: var(--cyan); flex: none; }
  .fgs { color: color-mix(in srgb, var(--fg) 85%, transparent); }
  .gap { margin-left: 1.5ch; }
  .nowrap { flex: none; font-variant-numeric: tabular-nums; }
</style>
