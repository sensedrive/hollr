<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // One "Braucht dich" entry (InboxSection.swift, widened for the desktop): what it is at a glance – kind, project,
  // branch, session, the question or the agent's last words, TODO progress, since when – and everything you can do
  // without opening the chat: pick an option (1–9), answer the whole ask (AskCard), reply (shares the chat's
  // draft), open chat / terminal / git / a dev server, mark as seen, end the session.
  import type { AskPick } from "$lib/api";
  import { draftKey } from "$lib/drafts";
  import { duration, type WebPort } from "$lib/agent";
  import { identityColor, type FocusKind, type Project, type SessionContext } from "$lib/dashboard";
  import { t } from "$lib/i18n";
  import * as api from "$lib/api";
  import { answer, answerPicks, dismiss, inbox, reply, type InboxEntry } from "$lib/inbox.svelte";
  import { drafts, type AgentOpen, type PaneRef } from "$lib/store.svelte";
  import AskCard from "$lib/components/AskCard.svelte";
  import { agentName, refTitle, relTime } from "./util";

  let { kind, since, ref, entry, ctx, project, ports, selected, onOpen, onEnd, onSelect, onHide }: {
    kind: FocusKind;
    since: number;
    ref: PaneRef;
    /** the inbox entry (absent for a long-running turn) */
    entry?: InboxEntry & { ref: PaneRef };
    ctx?: SessionContext;
    project: Project;
    ports: WebPort[];
    selected: boolean;
    onOpen: (open?: AgentOpen, url?: string) => void;
    onEnd: () => void;
    onSelect: () => void;
    /** a long-running turn: take it out of the list (the session keeps running) */
    onHide: () => void;
  } = $props();

  let input = $state<HTMLTextAreaElement>();
  let sending = $state(false);
  let sendError = $state("");
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(timer);
  });

  const key = $derived(draftKey(ref.server.id, ref.pane.pane));
  const color = $derived(
    kind === "error" ? "var(--red)" : kind === "done" ? "var(--accent)" : kind === "long" ? "var(--purple)" : "var(--orange)",
  );
  const icon = $derived(kind === "done" ? "✓" : kind === "error" ? "⚠" : kind === "long" ? "◷" : "?");
  const agent = $derived(agentName(ref.pane));
  const label = $derived(
    kind === "ask" ? t("{agent} fragt dich", { agent })
    : kind === "waiting" ? t("{agent} wartet auf dich", { agent })
    : kind === "error" ? t("{agent}: Fehler", { agent })
    : kind === "done" ? t("{agent} ist fertig", { agent })
    : t("{agent} arbeitet seit {d}", { agent, d: duration(now - since) }),
  );
  const title = $derived(refTitle(ref));
  /** one-tap options (a single question); several questions / multi-select go through the AskCard */
  const options = $derived(kind === "ask" ? (entry?.options ?? []) : []);
  /** questions and errors want an answer – results and long runs only on request (one main action per card) */
  let replying = $state(false);
  $effect.pre(() => { if (kind === "ask" || kind === "waiting" || kind === "error") replying = true; });
  const fullAsk = $derived(kind === "ask" && !options.length && ctx?.ask ? ctx.ask : undefined);
  const body = $derived(
    kind === "ask" ? entry?.question
    : kind === "long" ? (ctx?.step ?? ctx?.last)
    : (entry?.text ?? ctx?.last ?? (kind === "error" ? t("Mit einem Fehler gestoppt") : undefined)),
  );
  const placeholder = $derived(
    kind === "ask" ? t("Eigene Antwort …") : kind === "done" ? t("Weiter …") : t("Nachricht an {agent} …", { agent }),
  );
  const text = $derived(drafts.text(key));
  const error = $derived(sendError || (entry ? inbox.errors[entry.key] : undefined));

  export function focusReply() {
    input?.focus();
  }

  export function pick(index: number) {
    if (entry && index < options.length) answer(entry, index);
  }

  async function send() {
    const msg = text.trim();
    if (!msg || sending) return;
    sending = true;
    sendError = "";
    drafts.setText(key, "");
    drafts.beginSend(key, msg);
    let ok: boolean;
    if (entry) ok = await reply(entry, msg);
    else
      ok = await api.prompt(ref.server.id, ref.pane.pane, msg).then(
        () => true,
        (e) => ((sendError = e instanceof Error ? e.message : String(e)), false),
      );
    drafts.endSend(key, msg, ok);
    sending = false;
  }

  async function answerAll(ask: string, picks: AskPick[]) {
    return entry ? answerPicks(entry, ask, picks) : false;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="focus" class:sel={selected} style:--c={color} data-fid="f:{ref.id}" tabindex="-1" role="group" aria-label={title}
  onfocusin={onSelect} onpointerdown={onSelect}>
  <div class="head">
    <span class="kind"><b>{icon}</b> {label}</span>
    <span class="proj" style:--p={identityColor(project.name)} title={project.root ?? ""}>{project.name}</span>
    {#if project.branch}<span class="branch mono" title={project.worktree ? t("Git-Worktree") : t("Branch")}><Icon name="⑂" size={15} /> {project.branch}{#if project.worktree} <Icon name="⧉" size={15} />{/if}</span>{/if}
    <span class="grow"></span>
    {#if kind !== "long"}<span class="dim small" title={new Date(since).toLocaleString()}>{relTime(since)}</span>{/if}
    {#if entry}
      <button class="x" title="{t('Als gesehen markieren')} (E)" aria-label={t("Als gesehen markieren")} onclick={() => dismiss(entry)}><Icon name="✓" size={15} /></button>
    {:else if kind === "long"}
      <button class="x" title="{t('Aus der Liste nehmen')} (E)" aria-label={t("Aus der Liste nehmen")} onclick={onHide}><Icon name="✓" size={15} /></button>
    {/if}
  </div>

  <button class="title" onclick={() => onOpen()} title="{t('Chat öffnen')} (↩)">
    <span class="ellipsis">{title}</span>
    {#if ctx?.title && ctx.title !== title}<span class="sub ellipsis">{ctx.title}</span>{/if}
  </button>

  {#if body}<div class="text" class:q={kind === "ask"}>{body}</div>{/if}

  {#if options.length}
    <div class="opts">
      {#each options as opt, i}
        <button class="opt" onclick={() => pick(i)} title={i < 9 ? t("Taste {n}", { n: i + 1 }) : undefined}>
          <b class="n">{i + 1}</b><span class="grow">{opt}</span>
          {#if i === entry?.recommended}<span class="rec">{t("Empfohlen")}</span>{/if}
        </button>
      {/each}
    </div>
  {:else if fullAsk}
    <AskCard item={fullAsk} onAnswer={answerAll} />
  {/if}

  {#if ctx?.todo}
    {@const todo = ctx.todo}
    <div class="todo" title={todo.current ?? ""}>
      <span class="bar"><span style:width="{(todo.done / todo.total) * 100}%"></span></span>
      <span class="mono small">{todo.done}/{todo.total}</span>
      {#if todo.current}<span class="small muted ellipsis">{todo.current}</span>{/if}
    </div>
  {/if}

  {#if replying}
  <form class="reply" onsubmit={(e) => { e.preventDefault(); send(); }}>
    <textarea bind:this={input} rows="1" value={text} {placeholder} disabled={sending}
      oninput={(e) => drafts.setText(key, e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.stopPropagation(); input?.blur(); }
      }}></textarea>
    <button class="btn send" type="submit" disabled={!text.trim() || sending} title={t("Senden")} aria-label={t("Senden")}>↑</button>
  </form>
  {/if}

  <div class="actions">
    <button class="btn" class:primary={!replying} onclick={() => onOpen()} title="{t('Chat öffnen')} (↩)"><Icon name="↗" size={15} /> {t("Chat öffnen")}</button>
    {#if !replying}<button class="btn" onclick={() => (replying = true)}><Icon name="↩" size={15} /> {t("Antworten")}</button>{/if}
    <button class="btn" onclick={() => onOpen("terminal")} title="{t('Terminal öffnen')} (T)"><Icon name="terminal" size={14} /> {t("Terminal")}</button>
    <button class="btn" onclick={() => onOpen("git")} title="{t('Git & Dateien')} (G)"><Icon name="⑂" size={15} /> {t("Git")}{#if project.dirty}<span class="dirty">{project.dirty}</span>{/if}</button>
    {#each ports.slice(0, 2) as p (p.port)}
      <button class="btn" onclick={() => onOpen("browser", `http://localhost:${p.port}`)} title={p.title ?? p.process ?? ""}><Icon name="◍" size={15} /> :{p.port}</button>
    {/each}
    <span class="grow"></span>
    <button class="btn danger" onclick={onEnd} title={t("Sitzung beenden")}><Icon name="✕" size={15} /></button>
  </div>
  {#if error}<div class="small err">{t("Senden fehlgeschlagen: {e}", { e: error })}</div>{/if}
</div>

<style>
  .focus { display: grid; gap: 9px; padding: 13px 14px; border-radius: 16px; background: var(--raised); outline: none;
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); transition: border-color .12s, box-shadow .12s; min-width: 0; }
  .focus.sel { border-color: var(--c); box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 30%, transparent); }
  .head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
  .kind { color: var(--c); font-weight: 600; white-space: nowrap; }
  .kind b { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 10px;
    background: color-mix(in srgb, var(--c) 20%, transparent); }
  .proj { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .proj::before { content: ""; width: 4px; height: 13px; border-radius: 2px; background: var(--p); flex: none; }
  .branch { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .x { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--dim); }
  .x:hover, .x:focus-visible { color: var(--green); background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .title { all: unset; cursor: pointer; display: flex; align-items: baseline; gap: 8px; min-width: 0; font-weight: 650; font-size: 14.5px; }
  .title:hover > span:first-child, .title:focus-visible > span:first-child { color: var(--accent); }
  .title .sub { font-weight: 400; font-size: 12.5px; color: var(--muted); }
  .text { font-size: 13px; line-height: 1.45; color: color-mix(in srgb, var(--fg) 85%, transparent); white-space: pre-wrap; user-select: text;
    display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .text.q { color: var(--fg); }
  .opts { display: grid; gap: 6px; }
  .opt { all: unset; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 8px 12px; border-radius: 10px; font-size: 13px;
    background: color-mix(in srgb, var(--fg) 7%, transparent); }
  .opt:hover, .opt:focus-visible { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .n { color: var(--accent); font-variant-numeric: tabular-nums; font-size: 12px; }
  .rec { font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 99px; color: var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .todo { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .bar { width: 90px; flex: none; height: 5px; border-radius: 99px; background: color-mix(in srgb, var(--fg) 10%, transparent); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--green); border-radius: 99px; }
  .reply { display: flex; gap: 6px; align-items: flex-end; }
  .reply textarea { flex: 1; min-width: 0; resize: none; field-sizing: content; max-height: 120px; padding: 7px 11px; font: inherit; font-size: 13px;
    border-radius: 10px; }
  .send { width: 32px; height: 32px; padding: 0; border-radius: 50%; display: grid; place-items: center; font-weight: 700; }
  .send:not(:disabled) { background: var(--accent); color: #fff; border-color: transparent; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .actions .btn { padding: 3px 10px; font-size: 12px; }
  .dirty { margin-left: 5px; font-size: 10.5px; color: var(--orange); }
  .danger:hover { color: var(--red); border-color: var(--red); }
  .err { color: var(--red); }
  .grow { flex: 1; min-width: 0; }
</style>
