<script lang="ts">
  import Icon from "$lib/components/git/Icon.svelte";
  // One "Braucht dich" entry: what it is at a glance – kind, project, branch, session, the question or the agent's
  // last words, TODO progress, since when. A click anywhere opens the session; the ✓ marks it as seen.
  import { duration } from "$lib/agent";
  import { identityColor, type FocusKind, type Project, type SessionContext } from "$lib/dashboard";
  import { t } from "$lib/i18n";
  import { dismiss, type InboxEntry } from "$lib/inbox.svelte";
  import type { AgentOpen, PaneRef } from "$lib/store.svelte";
  import { agentName, refTitle, relTime } from "./util";

  let { kind, since, ref, entry, ctx, project, selected, onOpen, onSelect, onHide }: {
    kind: FocusKind;
    since: number;
    ref: PaneRef;
    /** the inbox entry (absent for a long-running turn) */
    entry?: InboxEntry & { ref: PaneRef };
    ctx?: SessionContext;
    project: Project;
    selected: boolean;
    onOpen: (open?: AgentOpen, url?: string) => void;
    onSelect: () => void;
    /** a long-running turn: take it out of the list (the session keeps running) */
    onHide: () => void;
  } = $props();

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(timer);
  });

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
  const body = $derived(
    kind === "ask" ? entry?.question
    : kind === "long" ? (ctx?.step ?? ctx?.last)
    : (entry?.text ?? ctx?.last ?? (kind === "error" ? t("Mit einem Fehler gestoppt") : undefined)),
  );
</script>

<!-- the whole card opens the session; only the ✓ in its head does something else -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div class="focus" class:sel={selected} style:--c={color} data-fid="f:{ref.id}" tabindex="-1" role="group" aria-label={title}
  title="{t('Chat öffnen')} (↩)"
  onfocusin={onSelect} onpointerdown={onSelect} onclick={(e) => !(e.target as Element).closest("button") && onOpen()}>
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

  <div class="title">
    <span class="ellipsis">{title}</span>
    {#if ctx?.title && ctx.title !== title}<span class="sub ellipsis">{ctx.title}</span>{/if}
  </div>

  {#if body}<div class="text" class:q={kind === "ask"}>{body}</div>{/if}


  {#if ctx?.todo}
    {@const todo = ctx.todo}
    <div class="todo" title={todo.current ?? ""}>
      <span class="bar"><span style:width="{(todo.done / todo.total) * 100}%"></span></span>
      <span class="mono small">{todo.done}/{todo.total}</span>
      {#if todo.current}<span class="small muted ellipsis">{todo.current}</span>{/if}
    </div>
  {/if}

</div>

<style>
  .focus { display: grid; gap: 9px; padding: 13px 14px; border-radius: 16px; background: var(--raised); outline: none;
    border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); transition: border-color .12s, box-shadow .12s; min-width: 0; }
  .focus.sel { border-color: var(--c); box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 30%, transparent); }
  .head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
  .focus { cursor: pointer; }
  .focus:hover { border-color: var(--c); }
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
  .todo { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .bar { width: 90px; flex: none; height: 5px; border-radius: 99px; background: color-mix(in srgb, var(--fg) 10%, transparent); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--green); border-radius: 99px; }
  .grow { flex: 1; min-width: 0; }
</style>
