// Provider usage limits per server (`hollr gate usage`, cached ~2 min on the server).
import { gate } from "$lib/api";
import { app } from "$lib/store.svelte";

export interface UsageLimit {
  provider: string;
  account?: string;
  label: string;
  window: string;
  used: number;
  resetsAt?: number;
  status?: string;
}

/** pooled across all accounts of a provider (what omp rotates through) */
export interface UsageCapacity {
  provider: string;
  window: string;
  meter?: string;
  accounts: number;
  used: number;
}

export const usage = $state({
  limits: {} as Record<string, UsageLimit[]>,
  capacity: {} as Record<string, UsageCapacity[]>,
});

const fetchedAt: Record<string, number> = {};

export async function refreshUsage(force = false) {
  await Promise.all(
    app.servers.map(async (s) => {
      if (!force && Date.now() - (fetchedAt[s.id] ?? 0) < 110_000) return;
      try {
        const r = await gate<{ limits: UsageLimit[]; capacity?: UsageCapacity[] }>(s.id, force ? "usage refresh" : "usage");
        usage.limits[s.id] = r.limits ?? [];
        usage.capacity[s.id] = r.capacity ?? [];
        fetchedAt[s.id] = Date.now();
      } catch {}
    }),
  );
}

export function providerName(provider: string): string {
  return ({ anthropic: "Claude", "openai-codex": "ChatGPT", cursor: "Cursor", "ollama-cloud": "Ollama" } as Record<string, string>)[provider] ?? provider;
}

export const usedColor = (used: number, quiet = false) =>
  used > 0.85 ? "var(--red)" : used > 0.6 ? "var(--orange)" : quiet ? "var(--muted)" : "var(--green)";
