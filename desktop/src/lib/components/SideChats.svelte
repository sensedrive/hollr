<script lang="ts">
  // The session's "Nachfragen" panel: its sidechats as a small list, the chosen one below – the selected piece as a
  // quote, then only what was asked and answered after it (the fork knows the whole session; that part stays hidden),
  // and a field for the next question. The first question creates the fork (sidechats.svelte.ts).
  import { tick } from "svelte";
  import * as api from "$lib/api";
  import type { Timeline } from "$lib/api";
  import { t } from "$lib/i18n";
  import { forkError } from "$lib/sideWindow";
  import { sideItems } from "$lib/sidetalk";
  import { firstPrompt, questionOf, sideChatLabel, sidechats, type SideChat } from "$lib/sidechats.svelte";
  import TimelineView from "./TimelineView.svelte";
  import Icon from "./git/Icon.svelte";

  let { server, main, title, active = $bindable() }: { server: string; main: string; title: string; active?: string } = $props();

  const list = $derived(sidechats.of(server, main));
  const chat = $derived(list.find((c) => c.id === active) ?? list[0]);

  // ---- the chosen one's log, polled while it is shown
  let timeline = $state<Timeline | null>(null);
  $effect(() => {
    const c = chat;
    timeline = null;
    if (!c?.pane) return;
    const pane = c.pane;
    let gone = false;
    const load = async () => {
      try {
        const tl = await api.timeline(server, pane);
        if (!gone && tl) timeline = tl;
      } catch {}
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  });
  /** after the fork only, the first question without the quote and context sent with it */
  const shown = $derived.by((): Timeline | null => {
    if (!timeline || !chat?.at) return null;
    const items = sideItems(timeline.items, chat.at).map((i) => (i.k === "user" ? { ...i, text: questionOf(i.text) } : i));
    return { ...timeline, items };
  });
  const running = $derived(!!timeline?.running);
  const statusOf = (c: SideChat) => (c.id === chat?.id && running ? "working" : !c.pane ? "new" : "");

  // ---- asking
  let text = $state("");
  let pending = $state("");
  let busy = $state(false);
  let starting = $state(false);
  let error = $state("");
  let input = $state<HTMLTextAreaElement>();
  $effect(() => {
    void chat?.id;
    void tick().then(() => input?.focus());
  });
  // the question we sent shows until the log has it
  $effect(() => {
    if (pending && shown?.items.some((i) => i.k === "user" && i.text.trim() === pending.trim())) pending = "";
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** a fresh fork loads the session first – the first prompt waits for it */
  async function promptWhenReady(pane: string, msg: string) {
    for (let i = 0; ; i++) {
      try {
        return await api.prompt(server, pane, msg);
      } catch (e) {
        if (i >= 30) throw e;
        await sleep(2000);
      }
    }
  }

  async function send() {
    const q = text.trim();
    const c = chat;
    if (!q || !c || busy) return;
    busy = true;
    error = "";
    pending = q;
    text = "";
    try {
      if (!c.pane) {
        starting = true;
        const r = await api.fork(server, main, sideChatLabel(c.quote));
        sidechats.forked(c.id, r.pane, r.at);
        starting = false;
        await promptWhenReady(r.pane, firstPrompt(c.quote, q));
      } else await api.prompt(server, c.pane, q);
    } catch (e) {
      error = c.pane ? (e instanceof Error ? e.message : String(e)) : forkError(e);
      text = q;
      pending = "";
    } finally {
      busy = starting = false;
    }
  }

  async function remove(c: SideChat) {
    if (c.pane) await api.closeFork(server, c.pane).catch(() => {});
    sidechats.remove(c.id);
    if (active === c.id) active = undefined;
  }

  const when = (ms: number) => {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
  };
</script>

<div class="chats">
  {#if list.length}
    <div class="list" role="list" aria-label={t("Nachfragen")}>
      {#each list as c (c.id)}
        {@const st = statusOf(c)}
        <div class="item" class:on={c.id === chat?.id} role="listitem">
          <button class="pick" aria-current={c.id === chat?.id} onclick={() => (active = c.id)} title={c.quote}>
            <span class="dot {st}"></span>
            <span class="q">„{c.quote}“</span>
            <span class="when">{when(c.created)}</span>
          </button>
          <button class="del" title={t("Nachfrage löschen")} aria-label={t("Nachfrage löschen")} onclick={() => remove(c)}><Icon name="x" size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if chat}
    <div class="active">
      <div class="scroll">
        <blockquote class="quote">{chat.quote}</blockquote>
        <span class="ctx"><Icon name="info" size={12} /> {t("Kennt den ganzen Verlauf von „{title}“ · ändert nichts", { title })}</span>
        {#if shown}
          <TimelineView timeline={shown} overview={false} onAnswer={(ask, picks) => api.answer(server, chat.pane!, ask, picks).then(() => true, () => false)} />
        {/if}
        {#if pending}<p class="mine">{pending}</p>{/if}
        {#if starting}
          <span class="thinking"><Icon name="loader" size={13} spin /> {t("Nachfrage startet – der Verlauf wird kopiert …")}</span>
        {:else if running || (pending && chat.pane)}
          <span class="thinking"><Icon name="loader" size={13} spin /> {t("denkt nach …")}</span>
        {/if}
        {#if error}<div class="err small"><Icon name="alert" size={13} /> {error}</div>{/if}
      </div>
      <form class="compose" onsubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea bind:this={input} bind:value={text} rows="1" disabled={busy}
          placeholder={chat.pane ? t("Weiter nachfragen …") : t("Was willst du dazu wissen?")} aria-label={t("Frage zum Ausschnitt")}
          onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }}></textarea>
        <button class="send" class:ready={!!text.trim() && !busy} type="submit" disabled={!text.trim() || busy} aria-label={t("Senden")} title={t("Senden")}>
          <Icon name="up" size={15} />
        </button>
      </form>
    </div>
  {:else}
    <div class="empty">
      <span class="eico"><Icon name="message" size={18} /></span>
      <span>{t("Text im Chat markieren und „Nachfragen“ wählen.")}</span>
    </div>
  {/if}
</div>

<style>
  .chats { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .list { display: grid; gap: 2px; padding: 8px; border-bottom: 1px solid var(--border); max-height: 190px; overflow-y: auto; flex: none; }
  .item { position: relative; border-radius: 8px; }
  .item:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .pick { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; column-gap: 8px; align-items: center;
    width: 100%; padding: 6px 30px 6px 8px; border-radius: 8px; }
  .pick:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; justify-self: center; }
  .dot.working { background: var(--purple); animation: pulse 1.6s ease-in-out infinite; }
  .dot.new { border: 1.5px solid var(--accent); box-sizing: border-box; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .q { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .on .q { font-weight: 600; }
  .when { font-size: 11.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .del { all: unset; cursor: pointer; position: absolute; right: 4px; top: 50%; translate: 0 -50%; width: 22px; height: 22px; display: grid; place-items: center;
    border-radius: 5px; color: var(--dim); opacity: 0; }
  .item:hover .del, .item:focus-within .del { opacity: 1; }
  .del:hover { background: var(--border); color: var(--fg); }
  .del:focus-visible { outline: 2px solid var(--accent); }
  .active { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 14px; }
  .quote { margin: 0; padding: 8px 12px; border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; background: color-mix(in srgb, var(--accent) 7%, transparent);
    font-size: 13px; line-height: 1.55; color: var(--muted); white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 8; line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
  .ctx { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim); margin-top: -6px; }
  .mine { align-self: flex-end; max-width: 88%; margin: 0; padding: 8px 12px; border-radius: 12px; background: var(--card); font-size: 13.5px; opacity: 0.7; white-space: pre-wrap; }
  .thinking { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dim); }
  .err { color: var(--orange); display: flex; gap: 6px; align-items: center; }
  .small { font-size: 12px; }
  .compose { display: flex; gap: 6px; align-items: flex-end; padding: 10px 12px 12px; border-top: 1px solid var(--border); flex: none; }
  .compose textarea { flex: 1; min-width: 0; resize: none; field-sizing: content; min-height: 38px; max-height: 160px; padding: 8px 12px; font: inherit; font-size: 13.5px;
    border-radius: 12px; }
  .send { all: unset; cursor: pointer; width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 50%;
    background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--dim); }
  .send.ready { background: var(--accent); color: #fff; }
  .send:disabled { cursor: default; }
  .send:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
  .eico { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--card); color: var(--accent); }
  /* the log inside: a narrow column – user messages a little smaller */
  .scroll :global(.tl) { gap: 12px; }
</style>
