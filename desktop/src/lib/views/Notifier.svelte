<script lang="ts">
  // Desktop notifications (agent waits / finishes / fails). Mounted once by the shell, renders nothing.
  // Mirrors server/src/watch.ts (diffStates) and the texts of server/src/push.ts: "waiting" fires at once,
  // "done" only after ≥ 5 s of work and when idle holds for ~3.5 s. Watches app.trees (refreshed every 5 s).
  import { onDestroy } from "svelte";
  import * as api from "$lib/api";
  import { t } from "$lib/i18n";
  import { settings } from "$lib/settings.svelte";
  import { allPanes, app, nav, tabName } from "$lib/store.svelte";
  import { notify, notifyKinds, type NoticeKind } from "./settings/notify.svelte";

  interface Seen {
    status: string;
    /** when the agent started working */
    since: number;
    /** finished, waiting to confirm it stays idle */
    pendingDone?: number;
  }

  const MIN_WORK_MS = 5000;
  const CONFIRM_MS = 3500;
  const isIdle = (s: string) => s === "idle" || s === "done";
  const seen = new Map<string, Seen>();

  type Event = { id: string; kind: "waiting" | "done"; workedMs: number };

  function diffStates(agents: { id: string; status: string }[], now: number): Event[] {
    const events: Event[] = [];
    const present = new Set<string>();
    for (const a of agents) {
      present.add(a.id);
      const prev = seen.get(a.id);
      if (!prev) {
        seen.set(a.id, { status: a.status, since: now });
        continue;
      }
      if (a.status === "working" && prev.status !== "working") {
        // a pending "done" that turned back into work was just a pause
        seen.set(a.id, { status: "working", since: prev.pendingDone ? prev.since : now });
        continue;
      }
      if (a.status === "blocked" && prev.status !== "blocked") {
        events.push({ id: a.id, kind: "waiting", workedMs: now - prev.since });
        seen.set(a.id, { status: "blocked", since: prev.since });
        continue;
      }
      if (isIdle(a.status) && prev.status === "working") {
        seen.set(a.id, { status: a.status, since: prev.since, pendingDone: now });
        continue;
      }
      if (isIdle(a.status) && prev.pendingDone && now - prev.pendingDone >= CONFIRM_MS) {
        const worked = prev.pendingDone - prev.since;
        if (worked >= MIN_WORK_MS) events.push({ id: a.id, kind: "done", workedMs: worked });
        seen.set(a.id, { status: a.status, since: now });
        continue;
      }
      if (a.status !== prev.status) seen.set(a.id, { ...prev, status: a.status });
    }
    for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
    return events;
  }

  function duration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
  }

  function plain(markdown: string, max = 220): string {
    const text = markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[`*_#>|]/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /** the agent's question, last answer or error – like describe() in watch.ts */
  async function describe(server: string, pane: string, kind: "waiting" | "done"): Promise<{ body: string; error?: boolean }> {
    try {
      const items = [...(await api.timeline(server, pane)).items].reverse();
      if (kind === "waiting") {
        const ask = items.find((i) => i.k === "ask" && i.pending);
        if (ask && ask.k === "ask") {
          const options = ask.options.length ? ` (${ask.options.slice(0, 3).join(" / ")})` : "";
          return { body: plain(ask.question + options) };
        }
      } else {
        const end = items.find((i) => i.k === "end");
        if (end && end.k === "end" && end.status === "error")
          return { body: plain(t("Fehler: {error}", { error: end.error ?? t("unbekannt") })), error: true };
        const text = items.find((i) => i.k === "text");
        if (text && text.k === "text") return { body: plain(text.text) };
      }
    } catch {}
    return { body: kind === "waiting" ? t("Wartet auf dich") : t("Fertig") };
  }

  /** the user is looking at this session right now */
  function inView(id: string): boolean {
    const r = nav.route;
    return r.view === "agent" && `${r.server}|${r.pane}` === id && document.visibilityState === "visible" && document.hasFocus();
  }

  async function fire(e: Event) {
    const ref = allPanes().find((r) => r.id === e.id);
    if (!ref || inView(e.id)) return;
    const agent = ref.pane.agent ?? "Agent";
    const info = await describe(ref.server.id, ref.pane.pane, e.kind);
    const kind: NoticeKind = info.error ? "error" : e.kind;
    if (!notifyKinds[kind] || !settings.notify || inView(e.id)) return;
    const subtitle =
      kind === "waiting"
        ? t("{agent} wartet auf dich", { agent })
        : kind === "error"
          ? t("{agent} ist mit einem Fehler gestoppt", { agent })
          : t("{agent} ist fertig · {time}", { agent, time: duration(e.workedMs) });
    const title = tabName(ref.tab.label, ref.workspace.label);
    const where = app.servers.length > 1 ? ` · ${ref.server.label}` : "";
    await notify(`${title}${where}`, `${subtitle}\n${info.body}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  function poll() {
    const agents = allPanes()
      .filter((r) => r.pane.agent)
      .map((r) => ({ id: r.id, status: r.pane.status }));
    const events = diffStates(agents, Date.now());
    if (!settings.notify) return; // keep the state machine current, but stay quiet
    for (const e of events) fire(e);
  }

  // app.trees[server] is reassigned on every refresh → this re-runs every 5 s (also when nothing changed,
  // which the idle confirmation needs). Debounced so one refresh of several servers counts once.
  $effect(() => {
    for (const s of app.servers) void app.trees[s.id];
    clearTimeout(timer);
    timer = setTimeout(poll, 300);
  });

  onDestroy(() => clearTimeout(timer));
</script>
