// The same machines (paired servers) and own settings in every Hollr app of the user. Each server keeps the user's
// machine list (`hollr gate machines`); this loop writes what this app knows there, reads the union back and acts
// on it (machinesSync.ts has the rules):
// - a machine removed on another device later than it was paired here is removed here too;
// - a machine this app lacks gets paired through an invite: this app asks (`request`) on every server it reaches,
//   another device paired with that machine asks it for a one-time link and leaves it here (`invite`), this app
//   `take`s it and pairs quietly – no dialog, no navigation;
// - this app answers such requests of the user's other devices the same way;
// - prompt snippets and the dictation vocabulary: the newest edit wins on every device.
// Runs at start, when a feed connects, when a server reports a change to its list, and every 5 minutes. It only
// writes (`merge`) when a server's list lacks something newer from here – otherwise each write would report a
// change to every app, which would sync and write again.
import { invoke } from "@tauri-apps/api/core";
import * as api from "./api";
import { dictation, takeVocabulary } from "./dictation.svelte";
import {
  answerKey, entryOf, missing, needsMerge, newerPrefs, REQUEST_EVERY, toAnswer, toRemove, union, type Machine,
  type MachinesDoc, type Prefs,
} from "./machinesSync";
import { snippets } from "./snippets.svelte";
import { loadServers } from "./store.svelte";

const EVERY = 5 * 60_000;
/** the name other devices' `hollr devices` show for this app (the pair dialog's default) */
const DEVICE_NAME = navigator.platform.toLowerCase().includes("mac") ? "Mac" : "Desktop";

export const machines = $state({
  /** the user's machines this app isn't paired with yet (Settings › Server greys them) */
  missing: [] as Machine[],
  /** fp → this app asked for it or is pairing with an invite right now */
  pending: {} as Record<string, boolean>,
  /** fp → why the last quiet pairing failed */
  errors: {} as Record<string, string | undefined>,
});

/** not reactive: per fp when this app last asked for it; the requests answered in this run */
const lastRequest: Record<string, number> = {};
const answered = new Set<string>();
let install: string | null | undefined;
let running: Promise<void> | undefined;
let again = false;

/** what goes to the servers' log of this app (Rust diag log), never a dialog */
const log = (line: string) => void invoke("diag_log", { line: `machines: ${line}` }).catch(() => {});
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** this app's settings with their edit times */
const localPrefs = (): Prefs => ({
  snippets: { value: [...snippets.list], updatedAt: snippets.updatedAt },
  vocabulary: { value: dictation.vocabularyText, updatedAt: dictation.vocabularyUpdatedAt },
});

/** One sync; a call while one runs runs once more afterwards (the change may have come too late for it). */
export function syncMachines(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      try {
        await run();
      } catch (e) {
        log(message(e));
      }
    } while (again);
  })().finally(() => (running = undefined));
  return running;
}

async function run() {
  install ??= await api.installId().catch(() => null);
  // the dev bridge has no install id: no sync there (it would write to the real servers' lists)
  if (!install) return;
  const servers = await api.servers();
  const stones: Machine[] = (await api.tombstones().catch(() => null)) ?? [];
  const local = [...servers.map(entryOf), ...stones];
  const prefs = localPrefs();

  // 1. every reachable server: read, and write what it lacks from here
  const reached: (MachinesDoc & { server: string })[] = [];
  await Promise.all(
    servers.map(async (s) => {
      try {
        let doc = await api.gate<MachinesDoc>(s.id, "machines", { op: "get" });
        if (needsMerge(doc, local, prefs)) doc = await api.gate<MachinesDoc>(s.id, "machines", { op: "merge", machines: local, prefs });
        reached.push({ ...doc, server: s.id });
      } catch {
        // unreachable, or a Hollr before the machine list (not_allowed): left out
      }
    }),
  );
  if (!reached.length) return;

  // 2. the union, newest per machine; the same for the settings
  const all = union([local, ...reached.map((d) => d.machines)]);
  takePrefs(newerPrefs(reached.map((d) => d.prefs)));

  // 3. removed elsewhere after it was paired here
  let changed = false;
  for (const { server, at } of toRemove(all, servers)) {
    try {
      await api.removeServer(server.id, at);
      log(`${server.label} wurde auf einem anderen Gerät entfernt – hier auch`);
      changed = true;
    } catch (e) {
      log(`${server.label} entfernen: ${message(e)}`);
    }
  }
  const kept = changed ? await api.servers() : servers;

  // 4. machines this app lacks: an invite left for it → pair quietly; none → ask again (at most every 2 minutes)
  const lacking = missing(all, kept, stones);
  if (lacking.length) {
    const invites = (
      await Promise.all(
        reached.map((d) =>
          api.gate<MachinesDoc>(d.server, "machines", { op: "take", install }).then((r) => r.taken ?? [], () => []),
        ),
      )
    ).flat();
    for (const m of lacking) {
      const invite = invites.find((i) => i.fp === m.fp && i.expires > Date.now());
      if (invite) {
        machines.pending[m.fp] = true;
        try {
          await api.pairInvite(invite.url, DEVICE_NAME, m.label, m.updatedAt);
          delete machines.errors[m.fp];
          log(`${m.label} gekoppelt (Einladung eines anderen Geräts)`);
          changed = true;
        } catch (e) {
          machines.errors[m.fp] = message(e);
          log(`${m.label} koppeln: ${message(e)}`);
        }
        continue;
      }
      if (Date.now() - (lastRequest[m.fp] ?? 0) < REQUEST_EVERY) continue;
      lastRequest[m.fp] = Date.now();
      await Promise.all(
        reached.map((d) =>
          api.gate(d.server, "machines", { op: "request", fp: m.fp, install, name: DEVICE_NAME }).catch(() => {}),
        ),
      );
    }
  }

  // 5. other installations asking for a machine paired here: a one-time link from that machine, left where asked
  const paired = new Map(kept.map((s) => [s.hostFingerprint, s.id]));
  for (const a of toAnswer(reached, install, paired, answered)) {
    const key = answerKey(a.request);
    answered.add(key);
    try {
      const { url } = await api.gate<{ url: string }>(a.via, "pairlink");
      await api.gate(a.source, "machines", { op: "invite", fp: a.request.fp, install: a.request.install, url });
      log(`Einladung für ${a.request.name || a.request.install} zu ${a.request.fp}`);
    } catch (e) {
      // the next sync tries again
      answered.delete(key);
      log(`Einladung ${a.request.fp}: ${message(e)}`);
    }
  }

  if (changed) await loadServers();
  const now = changed ? await api.servers() : kept;
  machines.missing = missing(all, now, stones);
  const asked = new Set(reached.flatMap((d) => d.requests.filter((r) => r.install === install).map((r) => r.fp)));
  const recent = (fp: string) => Date.now() - (lastRequest[fp] ?? 0) < REQUEST_EVERY;
  machines.pending = Object.fromEntries(machines.missing.filter((m) => asked.has(m.fp) || recent(m.fp)).map((m) => [m.fp, true]));
}

/** A newer setting from another device replaces the one here (the UI follows). */
function takePrefs(p: Prefs) {
  if (p.snippets && p.snippets.updatedAt > snippets.updatedAt) snippets.take(p.snippets.value, p.snippets.updatedAt);
  if (p.vocabulary && p.vocabulary.updatedAt > dictation.vocabularyUpdatedAt) takeVocabulary(p.vocabulary.value, p.vocabulary.updatedAt);
}

/** Starts the loop (once, from the shell); returns the stop. */
export function startMachines(): () => void {
  const offs: Promise<() => void>[] = [
    api.onChanged(({ machines: changed }) => {
      if (changed) void syncMachines();
    }),
    api.onFeed(({ live }) => {
      if (live) void syncMachines();
    }),
  ];
  const timer = setInterval(() => void syncMachines(), EVERY);
  void syncMachines();
  return () => {
    clearInterval(timer);
    for (const off of offs) void off.then((f) => f()).catch(() => {});
  };
}
