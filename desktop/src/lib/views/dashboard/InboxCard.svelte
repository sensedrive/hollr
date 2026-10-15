<script lang="ts">
  // One "Braucht dich" entry: status dot, title · agent · time, the question or last answer, and inline actions
  // (ask options, own answer, reply, open, dismiss). The card body opens the session.
  import { t } from "$lib/i18n";
  import { answer, dismiss, inbox, reply, type InboxEntry } from "$lib/inbox.svelte";
  import type { PaneRef } from "$lib/store.svelte";
  import { agentName, refTitle, relTime } from "./util";

  let { entry, onOpen }: { entry: InboxEntry & { ref: PaneRef }; onOpen: () => void } = $props();

  let replying = $state(false);
  let text = $state("");
  let sending = $state(false);
  let input = $state<HTMLInputElement>();

  const color = $derived(
    entry.kind === "error" ? "var(--red)" : entry.kind === "done" ? "var(--green)" : "var(--orange)",
  );
  const body = $derived(
    entry.kind === "ask" ? entry.question : entry.text ?? (entry.kind === "error" ? t("Mit einem Fehler gestoppt") : undefined),
  );
  /** waiting/done/error show the reply field right away, an ask only after "Eigene Antwort" */
  const showInput = $derived(entry.kind !== "ask" || replying);
  const placeholder = $derived(entry.kind === "waiting" || entry.kind === "ask" ? t("Antworten …") : t("Weiter …"));
  const error = $derived(inbox.errors[entry.key]);

  async function send() {
    const msg = text.trim();
    if (!msg || sending) return;
    sending = true;
    if (await reply(entry, msg)) text = "";
    sending = false;
  }

  function own() {
    replying = true;
    setTimeout(() => input?.focus());
  }
</script>

<div class="entry card" style:--c={color}>
  <button class="body" onclick={onOpen} title={t("Öffnen")}>
    <div class="top">
      <span class="dot"></span>
      <span class="title ellipsis">{refTitle(entry.ref)}</span>
      <span class="dim ellipsis">· {agentName(entry.ref.pane)} · {relTime(entry.since)}</span>
    </div>
    {#if body}<div class="text clamp2" class:q={entry.kind === "ask"}>{body}</div>{/if}
  </button>
  <button class="x" title={t("Ausblenden")} aria-label={t("Ausblenden")} onclick={() => dismiss(entry)}>×</button>

  <div class="actions">
    {#if entry.kind === "ask"}
      {#each entry.options ?? [] as opt, i}
        <button class="btn opt" onclick={() => answer(entry, i)} title={i < 4 ? t("Taste {n}", { n: i + 1 }) : undefined}>
          {#if i < 4}<span class="dim">{i + 1}</span>{/if}{opt}
        </button>
      {/each}
      {#if !replying}<button class="btn" onclick={own}>{t("Eigene Antwort")}</button>{/if}
    {/if}
    {#if showInput}
      <form class="reply" onsubmit={(e) => { e.preventDefault(); send(); }}>
        <input bind:this={input} bind:value={text} {placeholder} disabled={sending}
          onkeydown={(e) => { if (e.key === "Escape" && entry.kind === "ask") { replying = false; text = ""; } }} />
        <button class="btn" type="submit" disabled={!text.trim() || sending}>{t("Senden")}</button>
      </form>
    {/if}
    {#if entry.kind !== "ask"}<button class="btn" onclick={onOpen}>{t("Öffnen")}</button>{/if}
  </div>
  {#if error}<div class="small err">{t("Senden fehlgeschlagen: {e}", { e: error })}</div>{/if}
</div>

<style>
  .entry { position: relative; display: grid; gap: 8px; padding: 10px 12px; border-left: 3px solid var(--c); }
  .body { all: unset; cursor: pointer; display: grid; gap: 4px; min-width: 0; padding-right: 22px; border-radius: 6px; }
  .body:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .body:hover .title { color: var(--accent); }
  .top { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
  .title { font-weight: 600; flex: none; max-width: 55%; }
  .text { color: var(--muted); font-size: 12.5px; line-height: 1.4; }
  .text.q { color: var(--fg); }
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .x { all: unset; cursor: pointer; position: absolute; top: 6px; right: 8px; width: 20px; height: 20px; display: grid; place-items: center;
    border-radius: 6px; color: var(--dim); font-size: 15px; }
  .x:hover, .x:focus-visible { color: var(--fg); background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .actions .btn { padding: 4px 10px; font-size: 12px; }
  .opt { display: inline-flex; gap: 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reply { display: flex; gap: 6px; flex: 1; min-width: 200px; }
  .reply input { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; }
  .err { color: var(--red); }
</style>
