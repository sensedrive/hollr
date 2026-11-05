<script lang="ts">
  // omp's todo card, but only where the list changed: the newest state in full (phases, counts, ☐/☑, done struck
  // through, in progress highlighted, what just changed marked), older states fold to "Todo 3/8 · ✓ …".
  import type { ToolCall, TodoTask } from "../../api";
  import { phaseName } from "../../agent";
  import { phaseFolded, todoChanges, todoCounts, type TodoMark } from "../../chatTools";
  import { t } from "../../i18n";
  import { revealed } from "./reveal";

  let { calls, mark, tip }: { calls: ToolCall[]; mark: TodoMark; tip: string } = $props();

  const phases = $derived(calls.at(-1)?.todo ?? []);
  const counts = $derived(todoCounts(phases));
  const changed = $derived(todoChanges(mark.prev, phases));
  let open = $state<boolean | undefined>(undefined);
  const reveal = revealed();
  /** the find bar opens an older state (and its folded phases) with a hit */
  const forced = $derived(reveal.has(calls[0]?.id ?? ""));
  const isOpen = $derived(forced || (open ?? mark.latest));
  let openPhase = $state<Record<string, boolean>>({});

  const toggle = () => {
    if (!window.getSelection()?.toString()) open = !isOpen;
  };
  const box = (s: string) => ({ completed: "☑", in_progress: "◐", abandoned: "☒", blocked: "⊘" })[s] ?? "☐";
  const verb = (x: TodoTask) =>
    ({ completed: "✓", in_progress: "▸", abandoned: "✗", blocked: "⊘" })[x.status] ?? "+";
</script>

<div class="frame soft todo" class:compact={!isOpen} title={tip}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="hrow mid click" onclick={toggle} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
    role="button" tabindex="0" aria-expanded={isOpen}>
    <span class="acc">☑</span>
    <b>Todo</b>
    <span class="nowrap" class:ok={counts.done === counts.total}>{t("{done}/{total} erledigt", counts)}</span>
    {#if changed.length}
      <span class="ellipsis grow muted changes">
        {#each changed as x, i (i)}<span class="chg {x.status}">{verb(x)} {x.content}</span>{/each}
      </span>
    {:else}<span class="grow"></span>{/if}
    <span class="dim">{isOpen ? "▾" : "▸"}</span>
  </div>
  {#if isOpen}
    <div class="phases sel">
      {#each phases as p (p.name)}
        {@const done = p.tasks.filter((x) => x.status === "completed").length}
        {@const foldable = phaseFolded(p, changed)}
        {@const folded = foldable && !openPhase[p.name] && !forced}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="phase hrow" class:click={foldable} onclick={() => { if (foldable && !window.getSelection()?.toString()) openPhase[p.name] = folded; }}>
          <b>{phaseName(p, phases)}</b>
          <span class="dim" class:ok={done === p.tasks.length}>{done}/{p.tasks.length}</span>
          {#if folded}<span class="dim">▸</span>{/if}
        </div>
        {#if !folded}
          {#each p.tasks as x, i (i)}
            <div class="task hrow {x.status}" class:new={changed.includes(x)}>
              <span class="tree">{i === p.tasks.length - 1 ? "└─" : "├─"}</span>
              <span class="box">{box(x.status)}</span>
              <span class="txt">{x.content}</span>
            </div>
          {/each}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .todo.compact { padding: 6px 12px; background: transparent; }
  .changes { display: inline-flex; gap: 10px; }
  .chg.completed { color: var(--green); }
  .chg.in_progress { color: var(--orange); }
  .chg.abandoned { color: var(--red); }
  .phases { display: flex; flex-direction: column; gap: 1px; line-height: 1.55; }
  .phase { margin-top: 3px; }
  .phase:first-child { margin-top: 0; }
  .task { padding-left: 6px; border-radius: 4px; }
  .box { flex: none; width: 1.2em; text-align: center; color: var(--dim); }
  .txt { min-width: 0; overflow-wrap: anywhere; }
  .task.completed .box { color: var(--green); }
  .task.completed .txt { text-decoration: line-through; color: var(--dim); }
  .task.abandoned .box { color: var(--red); }
  .task.abandoned .txt { text-decoration: line-through; color: var(--dim); }
  .task.blocked .box, .task.blocked .txt { color: var(--yellow); }
  .task.in_progress .box { color: var(--orange); }
  .task.in_progress .txt { color: var(--orange); font-weight: 600; }
  /* what this update changed: a soft marker, so you see at a glance what got ticked */
  .task.new { background: color-mix(in srgb, var(--accent) 10%, transparent); }
</style>
