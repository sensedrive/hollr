<script lang="ts">
  // Settings → Integrationen: a JIRA API token entered once and stored on every paired machine
  // (`secrets` gate, server/src/secrets.ts). The token is only sent, never read back.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { gate } from "$lib/api";
  import { confirmAsk } from "$lib/ask.svelte";
  import { lang, t } from "$lib/i18n";
  import { errText } from "$lib/serverapi";
  import { app } from "$lib/store.svelte";

  interface JiraStatus { site: string; email: string; account: string | null; updatedAt: string }
  type Row = { jira: JiraStatus | null } | { error: string } | { offline: true } | { old: true };

  const TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
  let site = $state("leicht-luftig.atlassian.net");
  let email = $state("");
  let token = $state("");
  let saving = $state(false);
  let rows = $state<Record<string, Row>>({});
  let results = $state<Record<string, { ok: true } | { error: string }>>({});

  async function load(server: string) {
    if (app.errors[server]) {
      rows[server] = { offline: true };
      return;
    }
    try {
      const s = await gate<{ jira: JiraStatus | null }>(server, "secrets", { op: "status" });
      rows[server] = { jira: s.jira };
      if (!email && s.jira) {
        email = s.jira.email;
        site = s.jira.site;
      }
    } catch (e) {
      const text = errText(e);
      rows[server] = text === "not_allowed" ? { old: true } : { error: text };
    }
  }

  $effect(() => {
    for (const s of app.servers) void load(s.id);
  });

  const usable = (id: string) => {
    const r = rows[id];
    return !!r && ("jira" in r || "error" in r);
  };

  async function save() {
    saving = true;
    results = {};
    const targets = app.servers.filter((s) => usable(s.id));
    await Promise.all(
      targets.map(async (s) => {
        try {
          await gate(s.id, "secrets", { op: "set", name: "jira", site, email, token });
          results[s.id] = { ok: true };
        } catch (e) {
          results[s.id] = { error: errText(e) };
        }
        await load(s.id);
      }),
    );
    if (targets.length && targets.every((s) => "ok" in (results[s.id] ?? {}))) token = "";
    saving = false;
  }

  async function remove(server: string, label: string) {
    if (!(await confirmAsk(t("JIRA-Zugang von {server} entfernen?", { server: label }), { ok: t("Entfernen"), danger: true }))) return;
    try {
      await gate(server, "secrets", { op: "delete", name: "jira" });
      delete results[server];
    } catch (e) {
      results[server] = { error: errText(e) };
    }
    await load(server);
  }

  const date = (iso: string) => new Date(iso).toLocaleDateString(lang() === "en" ? "en-GB" : "de-DE");
  const open = (url: string) => openUrl(url).catch(() => window.open(url, "_blank"));
  const canSave = $derived(!saving && !!site.trim() && email.includes("@") && !!token && app.servers.some((s) => usable(s.id)));
</script>

<div class="page">
  <h1>{t("Integrationen")}</h1>

  <div class="section">JIRA</div>
  <div class="rows">
    <label class="row"><span class="lbl">{t("Site")}</span><input class="grow" bind:value={site} spellcheck="false" autocomplete="off" /></label>
    <label class="row"><span class="lbl">{t("E-Mail")}</span><input class="grow" type="email" bind:value={email} spellcheck="false" autocomplete="off" /></label>
    <label class="row"><span class="lbl">{t("API-Token")}</span><input class="grow" type="password" bind:value={token} autocomplete="new-password" /></label>
  </div>
  <div class="actions">
    <button class="link" onclick={() => open(TOKEN_URL)}>{t("Token anlegen")}</button>
    <button class="btn primary" disabled={!canSave} onclick={save}>{saving ? t("Speichert …") : t("Auf allen Rechnern speichern")}</button>
  </div>
  <p class="foot">{t("Das Token wird auf jedem Rechner geprüft und dort gespeichert; Hollr zeigt es danach nie wieder an.")}</p>

  <div class="section">{t("Rechner")}</div>
  <div class="rows">
    {#each app.servers as server (server.id)}
      {@const r = rows[server.id]}
      {@const res = results[server.id]}
      <div class="row">
        <span class="lbl">{server.label}</span>
        <span class="grow small">
          {#if !r}
            <span class="muted">…</span>
          {:else if "offline" in r}
            <span class="muted">{t("offline")}</span>
          {:else if "old" in r}
            <span class="warn">{t("Hollr zu alt – in Werkzeuge aktualisieren")}</span>
          {:else if "error" in r}
            <span class="bad">{r.error}</span>
          {:else if r.jira}
            {t("angemeldet als {account}", { account: r.jira.account ?? "?" })} · {r.jira.email} · {date(r.jira.updatedAt)}
          {:else}
            <span class="muted">{t("nicht hinterlegt")}</span>
          {/if}
          {#if res}
            <br />{#if "ok" in res}<span class="ok">✓ {t("gespeichert")}</span>{:else}<span class="bad">{res.error}</span>{/if}
          {/if}
        </span>
        {#if r && "jira" in r && r.jira}
          <button class="btn" onclick={() => remove(server.id, server.label)}>{t("Entfernen")}</button>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .lbl { width: 110px; flex: none; }
  .small { font-size: 12px; }
  .actions { display: flex; gap: 12px; align-items: center; justify-content: flex-end; margin: 10px 2px; }
  .link { all: unset; cursor: pointer; color: var(--accent); margin-right: auto; }
  .foot { font-size: 12px; color: var(--dim); margin: 4px 2px 0; }
  .muted { color: var(--muted); }
  .warn { color: var(--orange); }
  .bad { color: var(--red); }
  .ok { color: var(--green); }
</style>
