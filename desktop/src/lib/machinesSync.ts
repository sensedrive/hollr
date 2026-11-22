// The user's machines and own settings, the same in every Hollr app – pure part. Every server keeps a machine
// list (`hollr gate machines`, server/src/machines.ts); each app writes its paired servers and removals there,
// reads the union back, removes what was removed elsewhere and gets paired with what it lacks through invites
// another device asks the missing machine for. The loop itself is machines.svelte.ts.

/** One machine as the server keeps it; keyed by host key fingerprint, the newest `updatedAt` wins. */
export interface Machine {
  fp: string;
  label: string;
  addresses: string[];
  port: number;
  user: string;
  updatedAt: number;
  removed?: boolean;
}

/** An app installation that lacks machine `fp` (at most a day old). */
export interface PairRequest {
  fp: string;
  install: string;
  name: string;
  at: number;
}

/** A one-time pairing link for installation `install`. */
export interface Invite {
  fp: string;
  install: string;
  url: string;
  expires: number;
}

export interface Pref<T> {
  value: T;
  updatedAt: number;
}

/** Settings that belong to the user, not to a device. */
export interface Prefs {
  snippets?: Pref<string[]>;
  vocabulary?: Pref<string>;
}

/** what `machines` answers (`taken` for `take` only) */
export interface MachinesDoc {
  machines: Machine[];
  requests: PairRequest[];
  prefs?: Prefs;
  taken?: Invite[];
}

/** A paired server as this app keeps it (api.Server's relevant part). */
export interface LocalServer {
  id: string;
  label: string;
  addresses: string[];
  port: number;
  user: string;
  hostFingerprint: string;
  updatedAt: number;
}

/** a missing machine asks again at most this often */
export const REQUEST_EVERY = 2 * 60_000;

export const entryOf = (s: LocalServer): Machine => ({
  fp: s.hostFingerprint,
  label: s.label,
  addresses: s.addresses,
  port: s.port,
  user: s.user,
  updatedAt: s.updatedAt,
});

/** Newest entry per machine; equal times keep the first one seen (like the server). */
export function union(lists: Machine[][]): Map<string, Machine> {
  const out = new Map<string, Machine>();
  for (const list of lists)
    for (const m of list) {
      const have = out.get(m.fp);
      if (!have || m.updatedAt > have.updatedAt) out.set(m.fp, m);
    }
  return out;
}

/** Paired here but removed on another device later than this record was made → removed here too (at that time). */
export function toRemove(all: Map<string, Machine>, servers: LocalServer[]): { server: LocalServer; at: number }[] {
  return servers.flatMap((server) => {
    const m = all.get(server.hostFingerprint);
    return m?.removed && m.updatedAt > server.updatedAt ? [{ server, at: m.updatedAt }] : [];
  });
}

/** Machines of the user this app isn't paired with – unless it removed them itself later. */
export function missing(all: Map<string, Machine>, servers: LocalServer[], tombstones: Machine[]): Machine[] {
  const paired = new Set(servers.map((s) => s.hostFingerprint));
  return [...all.values()]
    .filter((m) => !m.removed && !paired.has(m.fp) && !tombstones.some((t) => t.fp === m.fp && t.updatedAt >= m.updatedAt))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The server's list lacks something this app knows newer – only then is `merge` (a write) needed. */
export function needsMerge(doc: Pick<MachinesDoc, "machines" | "prefs">, local: Machine[], prefs: Prefs): boolean {
  const have = union([doc.machines]);
  if (local.some((m) => (have.get(m.fp)?.updatedAt ?? -1) < m.updatedAt)) return true;
  return (["snippets", "vocabulary"] as const).some((k) => {
    const mine = prefs[k];
    return !!mine && (doc.prefs?.[k]?.updatedAt ?? -1) < mine.updatedAt;
  });
}

export const answerKey = (r: Pick<PairRequest, "fp" | "install" | "at">) => `${r.fp}|${r.install}|${r.at}`;

export interface Answer {
  /** the server the request was seen on – the invite goes there */
  source: string;
  /** the server to ask for a pairing link: the wanted machine itself */
  via: string;
  request: PairRequest;
}

/** Requests of other installations for machines paired here, not answered yet in this run. */
export function toAnswer(
  seen: { server: string; requests: PairRequest[] }[],
  install: string,
  paired: Map<string, string>,
  done: ReadonlySet<string>,
): Answer[] {
  const out: Answer[] = [];
  const taken = new Set(done);
  for (const { server, requests } of seen)
    for (const request of requests) {
      const via = paired.get(request.fp);
      const key = answerKey(request);
      if (request.install === install || !via || taken.has(key)) continue;
      taken.add(key);
      out.push({ source: server, via, request });
    }
  return out;
}

/** Newest value per setting wins. */
export function newerPrefs(lists: (Prefs | undefined)[]): Prefs {
  const out: Prefs = {};
  for (const p of lists) {
    if (p?.snippets && (!out.snippets || p.snippets.updatedAt > out.snippets.updatedAt)) out.snippets = p.snippets;
    if (p?.vocabulary && (!out.vocabulary || p.vocabulary.updatedAt > out.vocabulary.updatedAt)) out.vocabulary = p.vocabulary;
  }
  return out;
}
