<script lang="ts">
  // A background job of the session: what started it (intent, command, time) and – once done – its output.
  // omp keeps a running job's output in memory only, so it shows when the job is finished; until then it polls.
  import { onDestroy } from "svelte";
  import { t } from "$lib/i18n";
  import { jobDetail, type JobDetail } from "$lib/jobs.svelte";
  import { duration } from "$lib/agent";
  import Modal from "./Modal.svelte";

  let { server, pane, id, onClose }: { server: string; pane: string; id: string; onClose: () => void } = $props();

  let job = $state<JobDetail | null>(null);
  let error = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load() {
    try {
      job = await jobDetail(server, pane, id);
      error = "";
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      error = m === "not_allowed" ? t("Hollr auf dem Server ist zu alt – unter Server › Werkzeuge aktualisieren.") : m;
    }
    if (job?.status === "running") timer = setTimeout(load, 3000);
  }
  void load();
  onDestroy(() => clearTimeout(timer));
  const when = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : "");
</script>

<Modal title={`${t("Hintergrund-Job")} ${id}`} width={760} onClose={onClose}>
  {#if error}<div class="err">{error}</div>
  {:else if !job}<div class="dim">{t("Lädt …")}</div>
  {:else if job.status === "unknown"}<div class="dim">{t("Diesen Job gibt es im Verlauf dieser Sitzung nicht.")}</div>
  {:else}
    {#if job.intent}<div class="intent">{job.intent}</div>{/if}
    <div class="meta">
      <span>{job.tool}</span>
      {#if job.startedAt}<span>{t("gestartet")} {when(job.startedAt)}</span>{/if}
      {#if job.status === "running"}<span class="run">{t("läuft")} · {duration(Date.now() - (job.startedAt ?? Date.now()))}</span>
      {:else}<span class="ok">{t("fertig")} {when(job.finishedAt)}</span>{/if}
    </div>
    {#if job.command}<pre class="cmd">{job.command}</pre>{/if}
    <div class="label">{t("Ausgabe")}</div>
    {#if job.output}<pre class="out">{job.output}</pre>
    {:else}<div class="dim">{t("Die Ausgabe erscheint, sobald der Job fertig ist – omp hält sie bis dahin nur im Speicher.")}</div>{/if}
  {/if}
</Modal>

<style>
  .intent { font-weight: 600; }
  .meta { display: flex; gap: 12px; font-size: 12px; color: var(--muted); }
  .run { color: var(--yellow); }
  .ok { color: var(--green); }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--dim); }
  pre { margin: 0; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 6%, transparent);
    font: 12px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .cmd { max-height: 160px; overflow: auto; color: var(--muted); }
  .out { max-height: 50vh; overflow: auto; }
  .err { color: var(--red); }
  .dim { color: var(--dim); }
</style>
