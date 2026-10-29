<script lang="ts">
  // omp's question (AskCard in TimelineViews.swift): one question with one choice answers on click,
  // several questions or multi-select are filled in here and sent together. The server types the keys.
  import type { AskPick, TimelineItem } from "../api";
  import { t } from "../i18n";

  let { item, onAnswer }: {
    item: Extract<TimelineItem, { k: "ask" }>;
    /** false = not sent (the session view shows why) */
    onAnswer: (ask: string, picks: AskPick[]) => Promise<boolean>;
  } = $props();

  const questions = $derived(item.questions ?? [item]);
  const byClick = $derived(questions.length === 1 && !questions[0]?.multi);
  // what you picked, shown right away – omp's confirmation follows with the next refresh
  let picks: { options: number[]; text: string }[] = $state([]);
  let sending = $state(false);
  let sent = $state(false);
  $effect(() => {
    if (picks.length !== questions.length) picks = questions.map(() => ({ options: [], text: "" }));
  });
  const open = $derived(!!item.pending && !sent && !sending);
  /** every single-choice question has its answer (multi-select may stay empty, like in omp) */
  const complete = $derived(questions.every((q, i) => q.multi || !!picks[i]?.options.length || !!picks[i]?.text.trim()));

  function tap(qi: number, index: number) {
    const p = picks[qi];
    if (!p) return;
    if (byClick) {
      p.options = [index];
      void submit();
    } else if (questions[qi]?.multi) {
      p.options = p.options.includes(index) ? p.options.filter((x) => x !== index) : [...p.options, index];
    } else {
      p.options = [index];
      p.text = "";
    }
  }

  function typed(qi: number, text: string) {
    const p = picks[qi];
    if (!p) return;
    p.text = text;
    if (!questions[qi]?.multi && text.trim()) p.options = [];
  }

  async function submit() {
    sending = true;
    const ok = await onAnswer(item.id, picks.map((p) => ({ options: p.options, ...(p.text.trim() ? { text: p.text } : {}) })));
    sending = false;
    sent = ok;
    // not sent: choose again
    if (!ok && byClick) picks = questions.map(() => ({ options: [], text: "" }));
  }

  const chosen = (qi: number, i: number, opt: string) => !!picks[qi]?.options.includes(i) || !!item.answer?.includes(opt);
</script>

<div class="ask" class:pending={item.pending}>
  <div class="mono hrow"><b class="acc">?</b> <b class="small" class:warn={item.pending}>{item.pending ? t("Ask – omp wartet auf dich") : t("Ask")}</b>{#if questions.length === 1 && item.header}<span class="small muted"> · {item.header}</span>{/if}</div>
  {#each questions as q, qi}
    {#if questions.length > 1}
      <div class="mono small qhead"><b class="acc">{qi + 1}.</b>{#if q.header} <span class="muted">{q.header}</span>{/if}{#if q.multi} <span class="muted">{t("mehrere möglich")}</span>{/if}</div>
    {:else if q.multi}
      <div class="small muted">{t("mehrere möglich")}</div>
    {/if}
    <div class="q">{q.question}</div>
    {#each q.options as opt, i}
      <button class="opt" class:live={open} disabled={!open} onclick={() => tap(qi, i)}>
        <span class="acc">{q.multi ? (chosen(qi, i, opt) ? "☑" : "☐") : chosen(qi, i, opt) ? "◉" : "○"}</span>
        <span class="optbody">
          <span>{opt}{#if i === q.recommended}<span class="rec">{t("Empfohlen")}</span>{/if}</span>
          {#if open && q.descriptions?.[i]}<span class="desc">{q.descriptions[i]}</span>{/if}
        </span>
      </button>
    {/each}
    {#if open && !byClick}
      <!-- omp's own last row "Other (type your own)" -->
      <input class="own" placeholder={t("Eigene Antwort …")} value={picks[qi]?.text ?? ""} oninput={(e) => typed(qi, e.currentTarget.value)} />
    {/if}
  {/each}
  {#if item.pending && !sent}
    {#if byClick}
      <div class="small muted">✎ {t("Eigene Antwort? Einfach unten eintippen.")}</div>
    {:else}
      <button class="btn send" disabled={!complete || sending} onclick={submit}>{sending ? "…" : t("Antworten senden")}</button>
    {/if}
  {/if}
  {#if item.answer}<div class="mono small" class:ok={item.answer !== "abgebrochen"} class:warn={item.answer === "abgebrochen"}>✔ {item.answer}</div>{/if}
</div>

<style>
  .mono { font-family: var(--mono); }
  .hrow { display: flex; gap: 6px; align-items: baseline; }
  .acc { color: var(--orange); }
  .ok { color: var(--green); }
  .warn { color: var(--yellow); }
  .muted { color: var(--muted); }
  .optbody { display: inline-flex; flex-direction: column; gap: 2px; text-align: left; }
  .desc { font-size: 12px; color: var(--muted); }
  .rec { margin-left: 8px; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .small { font-size: 12px; }
  .ask { border: 1px solid color-mix(in srgb, var(--border) 60%, transparent); border-radius: 10px; padding: 12px; background: var(--raised);
    display: flex; flex-direction: column; gap: 8px; }
  .ask.pending { border-color: color-mix(in srgb, var(--yellow) 70%, transparent); }
  .qhead { margin-top: 6px; }
  .q { white-space: pre-wrap; user-select: text; }
  .opt { all: unset; display: flex; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 13.5px; cursor: default; }
  .opt.live { cursor: pointer; background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .opt.live:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .own { font-size: 13.5px; padding: 8px 10px; border-radius: 8px; }
  .send { align-self: stretch; }
</style>
