<script lang="ts">
  // Per-account details behind the quiet limits line ("Nutzungslimits").
  import Modal from "$lib/components/Modal.svelte";
  import { t } from "$lib/i18n";
  import { app } from "$lib/store.svelte";
  import { providerName, refreshUsage, usage, usedColor, type UsageLimit } from "./usage.svelte";
  import { relTime } from "./util";

  let { onClose }: { onClose: () => void } = $props();
  let busy = $state(false);

  // several servers report the same accounts: one row per limit (the highest value wins)
  const limits = $derived.by(() => {
    const best = new Map<string, UsageLimit>();
    for (const l of app.servers.flatMap((s) => usage.limits[s.id] ?? [])) {
      const key = [l.provider, l.account ?? "", l.label, l.window].join("|");
      const prev = best.get(key);
      if (!prev || l.used > prev.used) best.set(key, l);
    }
    return [...best.values()];
  });
  const providers = $derived(
    [...new Set(limits.map((l) => providerName(l.provider)))].sort().map((name) => {
      const items = limits.filter((l) => providerName(l.provider) === name);
      const accounts = [...new Set(items.map((l) => l.account ?? ""))].sort();
      return { name, multi: accounts.length > 1, accounts: accounts.map((a) => ({ account: a, rows: items.filter((l) => (l.account ?? "") === a) })) };
    }),
  );
  const short = (l: UsageLimit) => l.label.replace("Claude ", "");

  async function reload() { busy = true; await refreshUsage(true); busy = false; }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<Modal title={t("Nutzungslimits")} {onClose}>
  {#if !limits.length}<div class="muted">{t("Keine Limits gemeldet.")}</div>{/if}
  {#each providers as p}
    <div class="section">{p.name}</div>
    <div class="card list">
      {#each p.accounts as a}
        <div class="acct">
          {#if p.multi}<div class="small muted">{t("Konto {name}", { name: a.account })}</div>{/if}
          {#each a.rows as l}
            <div class="limit">
              <div class="line"><span class="grow">{short(l)}</span>
                <b style="color:{usedColor(l.used)}">{Math.round(l.used * 100)} %</b>
                {#if l.resetsAt}<span class="dim small">· {relTime(l.resetsAt)}</span>{/if}
              </div>
              <div class="bar"><div style="width:max(4px, {l.used * 100}%); background:{usedColor(l.used)}"></div></div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/each}
  <div class="buttons">
    <button class="btn" disabled={busy} onclick={reload}>{busy ? "…" : t("Aktualisieren")}</button>
    <button class="btn primary" onclick={onClose}>{t("Fertig")}</button>
  </div>
</Modal>

<style>
  .section { margin: 6px 0 -4px; }
  .list { display: grid; gap: 14px; }
  .acct { display: grid; gap: 10px; }
  .limit { display: grid; gap: 4px; }
  .line { display: flex; align-items: baseline; gap: 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--fg) 8%, transparent); overflow: hidden; }
  .bar div { height: 100%; border-radius: 99px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
</style>
