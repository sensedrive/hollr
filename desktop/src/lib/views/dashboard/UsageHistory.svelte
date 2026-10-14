<script lang="ts">
  // Usage history (beta): limits over time, use per day and agent time per machine.
  // Data comes from each server's watcher (`hollr gate usage history <days>`), like on the iPhone.
  import { gate } from "$lib/api";
  import { t } from "$lib/i18n";
  import { app } from "$lib/store.svelte";
  import { providerName } from "./usage.svelte";

  interface Limit { p: string; a?: string; l: string; w: string; u: number }
  interface History {
    host: string;
    samples: { at: number; limits: Limit[] }[];
    activity: { at: number; host: string; work: Record<string, number> }[];
  }
  interface Point { at: number; used: number }

  let days = $state(7);
  let histories = $state<{ server: string; label: string; h: History }[]>([]);
  let failed = $state<string[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    const results = await Promise.all(
      app.servers.map(async (s) => {
        try {
          return { server: s.id, label: s.label, h: await gate<History>(s.id, `usage history ${days}`) };
        } catch {
          return { server: s.id, label: s.label, h: undefined };
        }
      }),
    );
    histories = results.filter((r) => r.h).map((r) => r as { server: string; label: string; h: History });
    failed = results.filter((r) => !r.h).map((r) => r.label);
    loading = false;
  }
  $effect(() => {
    void days;
    load();
  });

  const COLORS = ["var(--accent)", "var(--green)", "var(--orange)", "var(--purple)", "var(--cyan)", "var(--pink)"];
  const W = 520;

  /** account → window → points (merged over servers: they see the same accounts) */
  const accounts = $derived.by(() => {
    const map = new Map<string, Map<string, Point[]>>();
    const seen = new Set<string>();
    const samples = histories.flatMap((x) => x.h.samples).sort((a, b) => a.at - b.at);
    for (const s of samples) {
      const slot = Math.floor(s.at / 600_000);
      for (const l of s.limits) {
        const account = `${providerName(l.p)} · ${l.a ?? "–"}`;
        const window = !l.l || l.l === l.w ? l.w : l.l;
        const key = `${account}|${window}|${slot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!map.has(account)) map.set(account, new Map());
        const series = map.get(account)!;
        if (!series.has(window)) series.set(window, []);
        series.get(window)!.push({ at: s.at, used: l.u });
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const range = $derived.by(() => {
    const now = Date.now();
    return { from: now - days * 86_400_000, to: now };
  });
  const x = (at: number) => ((at - range.from) / (range.to - range.from)) * W;

  function stepPath(points: Point[], h: number) {
    if (!points.length) return "";
    let d = `M${x(points[0]!.at)},${h - points[0]!.used * h}`;
    for (const p of points.slice(1)) d += `H${x(p.at)}V${h - p.used * h}`;
    return `${d}H${x(Math.min(Date.now(), range.to))}`;
  }

  const rank = (w: string) => {
    const s = w.toLowerCase();
    if (s.includes("fable")) return 0;
    if (s.includes("month") || s.includes("monat")) return 4;
    if (s.includes("7") || s.includes("week") || s.includes("day")) return 3;
    return 1;
  };
  const dayStart = (at: number) => {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dayList = $derived(Array.from({ length: Math.max(days, 1) }, (_, i) => dayStart(Date.now()) - (Math.max(days, 1) - 1 - i) * 86_400_000));

  /** increases of the longest window per day (resets are drops, not use) */
  function dailyUse(series: Map<string, Point[]>) {
    const main = [...series.keys()].sort((a, b) => rank(b) - rank(a))[0];
    const line = main ? (series.get(main) ?? []) : [];
    const per = new Map<number, number>();
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      if (b.used > a.used) per.set(dayStart(b.at), (per.get(dayStart(b.at)) ?? 0) + b.used - a.used);
    }
    return { main, per };
  }

  /** agent seconds per day and machine */
  const machines = $derived.by(() => {
    const per = new Map<number, Map<string, number>>();
    for (const { label, h } of histories)
      for (const b of h.activity) {
        const d = days === 1 ? Math.floor(b.at / 3_600_000) * 3_600_000 : dayStart(b.at);
        const row = per.get(d) ?? new Map<string, number>();
        row.set(label, (row.get(label) ?? 0) + Object.values(b.work).reduce((s, v) => s + v, 0));
        per.set(d, row);
      }
    return per;
  });
  const machineNames = $derived(histories.map((x) => x.label));
  const slots = $derived(days === 1 ? Array.from({ length: 24 }, (_, i) => Math.floor(Date.now() / 3_600_000) * 3_600_000 - (23 - i) * 3_600_000) : dayList);
  const maxMachine = $derived(Math.max(1, ...[...machines.values()].map((m) => [...m.values()].reduce((s, v) => s + v, 0))));
  const kinds = $derived.by(() => {
    const sums = new Map<string, number>();
    for (const { h } of histories) for (const b of h.activity) for (const [k, v] of Object.entries(b.work)) sums.set(k, (sums.get(k) ?? 0) + v);
    return [...sums.entries()].sort((a, b) => b[1] - a[1]);
  });
  const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
  const hasData = $derived(accounts.length > 0 || machines.size > 0);
  const label = (at: number) => new Date(at).toLocaleDateString(undefined, days === 1 ? undefined : { weekday: "short" });
</script>

<div class="seg">
  {#each [[1, "24 Std."], [7, "7 Tage"], [30, "30 Tage"]] as [d, name]}
    <button class:on={days === d} onclick={() => (days = d as number)}>{t(name as string)}</button>
  {/each}
</div>
{#if failed.length}<div class="small warn">{t("Kein Verlauf von: {names} (Hollr-Server aktualisieren)", { names: failed.join(", ") })}</div>{/if}

{#if loading && !histories.length}
  <div class="skeleton" style="height:160px"></div>
{:else if !hasData}
  <div class="muted">{t("Noch keine Daten. Der Hollr-Server zeichnet ab jetzt alle 10 Minuten auf – schau in einer Stunde wieder vorbei.")}</div>
{/if}

{#each accounts as [account, series]}
  {@const windows = [...series.keys()]}
  {@const use = dailyUse(series)}
  {@const maxUse = Math.max(0.01, ...use.per.values())}
  <div class="section">{account}</div>
  <div class="card chart">
    <b>{t("Auslastung")}</b>
    <svg viewBox="0 0 {W} 130" preserveAspectRatio="none">
      {#each [0, 0.5, 1] as g}<line x1="0" x2={W} y1={120 - g * 120} y2={120 - g * 120} class="grid" />{/each}
      {#each windows as w, i}
        <path d={stepPath(series.get(w) ?? [], 120)} fill="none" stroke={COLORS[i % COLORS.length]} stroke-width="2" vector-effect="non-scaling-stroke" />
      {/each}
    </svg>
    <div class="legend">
      {#each windows as w, i}<span><i style="background:{COLORS[i % COLORS.length]}"></i>{w}</span>{/each}
      <span class="dim">0–100 %</span>
    </div>
    <b>{t("Verbrauch pro Tag")}</b>
    <div class="dim small">{t("Prozentpunkte des längsten Limits (z. B. 7 Tage), die an dem Tag dazukamen")}{use.main ? ` · ${use.main}` : ""}</div>
    {#if use.per.size}
      <div class="bars">
        {#each dayList as d}
          {@const v = use.per.get(d) ?? 0}
          <div class="col" title="{label(d)}: {Math.round(v * 100)} %"><div class="fill" style="height:{(v / maxUse) * 100}%"></div><span>{days <= 7 ? label(d) : ""}</span></div>
        {/each}
      </div>
    {:else}<div class="dim small">{t("Noch kein Verbrauch aufgezeichnet.")}</div>{/if}
  </div>
{/each}

{#if machines.size}
  <div class="section">{t("Agent-Zeit pro Maschine")}</div>
  <div class="card chart">
    <div class="bars">
      {#each slots as d}
        {@const row = machines.get(d)}
        <div class="col" title={row ? [...row].map(([m, s]) => `${m}: ${hours(s)}`).join("\n") : ""}>
          <div class="stack">
            {#each machineNames as m, i}
              {@const s = row?.get(m) ?? 0}
              {#if s}<div style="height:{(s / maxMachine) * 100}%; background:{COLORS[i % COLORS.length]}"></div>{/if}
            {/each}
          </div>
          <span>{days === 7 ? label(d) : ""}</span>
        </div>
      {/each}
    </div>
    <div class="legend">{#each machineNames as m, i}<span><i style="background:{COLORS[i % COLORS.length]}"></i>{m}</span>{/each}</div>
    {#each kinds as [k, s]}<div class="kind"><span class="grow">{k}</span><span class="muted">{hours(s)}</span></div>{/each}
    <div class="dim small">{t("Wie lange Agents auf jeder Maschine gearbeitet haben – zeigt, wer die Limits verbraucht.")}</div>
  </div>
{/if}
<div class="dim small">{t("Beta. Prozente kommen von den Anbietern (omp usage) und werden vom Hollr-Server aufgezeichnet, Agent-Zeit misst der Server selbst. Gespeichert werden 30 Tage.")}</div>

<style>
  .seg { display: inline-flex; background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 2px; align-self: start; }
  .seg button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .seg button.on { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .section { margin: 6px 0 -4px; }
  .chart { display: grid; gap: 8px; }
  svg { width: 100%; height: 130px; }
  .grid { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--muted); }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 110px; }
  .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; min-width: 0; }
  .col span { font-size: 10px; color: var(--dim); text-align: center; height: 14px; overflow: hidden; }
  .fill { background: var(--accent); border-radius: 3px 3px 0 0; min-height: 0; }
  .stack { flex: 1; display: flex; flex-direction: column-reverse; justify-content: flex-start; }
  .stack div:last-child { border-radius: 3px 3px 0 0; }
  .kind { display: flex; font-size: 13px; }
  .warn { color: var(--orange); }
</style>
