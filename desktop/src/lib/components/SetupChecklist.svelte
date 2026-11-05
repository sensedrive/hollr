<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // Server › Einrichtung (iOS SetupChecklist): what is still missing on this computer, each with a fix –
  // install with a click, restart the watcher, or a command to copy. Push keys live in the iPhone app.
  import { t } from "../i18n";
  import * as sapi from "../serverapi";
  import type { Check } from "../serverapi";

  let { server, checks, reload }: { server: string; checks: Check[]; reload: () => Promise<void> | void } = $props();

  let busy = $state("");
  let message = $state("");
  let copied = $state("");

  const problems = $derived(checks.filter((c) => !c.ok));

  async function run(check: Check, fn: () => Promise<void>) {
    busy = check.name;
    try {
      await fn();
      await reload();
    } catch (e) {
      message = sapi.errText(e);
    } finally {
      busy = "";
    }
  }

  const install = (check: Check, tool: string) =>
    run(check, async () => {
      await sapi.tools(server, { run: tool });
      message = t("Installation läuft – in einer Minute neu prüfen.");
    });

  const restart = (check: Check) =>
    run(check, async () => {
      message = (await sapi.restartWatch(server)) ? t("Wächter läuft wieder.") : t("Neustart hat nicht geklappt.");
    });

  async function copyFix(check: Check) {
    if (check.fix && (await sapi.copy(check.fix))) {
      copied = check.name;
      setTimeout(() => copied === check.name && (copied = ""), 1800);
    }
  }
</script>

<div class="section">{t("Einrichtung · {ok}/{n} bereit", { ok: checks.length - problems.length, n: checks.length })}</div>
<div class="rows">
  {#if !problems.length}
    <div class="row allok"><Icon name="✓" size={15} /> {t("Alles eingerichtet")}</div>
  {/if}
  {#each problems as c (c.name)}
    {@const action = c.action ?? ""}
    <div class="row check">
      <span class="ico">!</span>
      <div class="grow">
        <div class="name">{c.name}</div>
        <div class="small muted">{c.detail}</div>
        {#if action.startsWith("tool:")}
          <button class="btn small act" disabled={!!busy} onclick={() => install(c, action.slice(5))}>
            {busy === c.name ? "…" : "↓"} {t("Installieren")}</button>
        {:else if action === "watch"}
          <button class="btn small act" disabled={!!busy} onclick={() => restart(c)}>
            {#if busy === c.name}…{:else}<Icon name="reload" size={14} />{/if} {t("Neu starten")}</button>
        {:else if action === "push"}
          <div class="small dim act">{t("Push richtest du in der Hollr-App auf dem iPhone ein: Server › Einrichtung › „Push einrichten“.")}</div>
        {:else if c.fix}
          <button class="fix mono" title={t("Befehl kopieren")} onclick={() => copyFix(c)}>
            <span class="ellipsis">{c.fix}</span><span><Icon name={copied === c.name ? "✓" : "⧉"} size={13} /></span>
          </button>
        {/if}
      </div>
    </div>
  {/each}
  {#if message}<div class="row small muted">{message}</div>{/if}
</div>

<style>
  .allok { color: var(--green); }
  .check { align-items: flex-start; }
  .ico { width: 18px; text-align: center; font-weight: 700; color: var(--orange); }
  .name { font-weight: 600; }
  .act { margin-top: 6px; }
  .fix { all: unset; cursor: pointer; display: flex; gap: 8px; max-width: 100%; margin-top: 4px; font-size: 12px; color: var(--accent);
    background: color-mix(in srgb, var(--fg) 6%, transparent); border-radius: 8px; padding: 4px 8px; box-sizing: border-box; }
  .fix:hover { background: color-mix(in srgb, var(--accent) 15%, transparent); }
</style>
