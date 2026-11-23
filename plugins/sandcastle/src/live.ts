/**
 * Phases of issues in this machine's live Sandcastle runs (`hollr gate sandcastle {"op":"status"}`), for the
 * drift rules. The gate parses run logs – a process start – so the answer is kept for 15 s and asked again in
 * the background; until the first answer, and when the gate fails, there are simply no live phases.
 */
import type { Gate } from "./projects";

const TTL_MS = 15_000;

interface RunLike {
  slug?: unknown;
  status?: unknown;
  issues?: { n?: unknown; phase?: unknown }[];
}

/** Issue number → phase for the runs of `slug` that have not ended (later runs win). */
export function phasesOf(status: unknown, slug: string): Map<number, string> {
  const out = new Map<number, string>();
  const runs = (status as { runs?: RunLike[] } | null)?.runs;
  if (!Array.isArray(runs)) return out;
  for (const r of runs) {
    if (r?.slug !== slug || r.status === "ended" || !Array.isArray(r.issues)) continue;
    for (const i of r.issues)
      if (typeof i?.n === "number" && typeof i.phase === "string") out.set(i.n, i.phase);
  }
  return out;
}

export class LiveRuns {
  private memo: { at: number; status: unknown } | undefined;
  private asking = false;

  constructor(
    private gate: Gate,
    private now: () => number = Date.now,
  ) {}

  phases(slug: string): Map<number, string> {
    if (!this.memo || this.now() - this.memo.at > TTL_MS) this.ask();
    return phasesOf(this.memo?.status, slug);
  }

  private ask() {
    if (this.asking) return;
    this.asking = true;
    this.gate("sandcastle", { op: "status" })
      .then((status) => {
        this.memo = { at: this.now(), status };
      })
      .catch(() => {
        this.memo = { at: this.now(), status: null };
      })
      .finally(() => {
        this.asking = false;
      });
  }
}
