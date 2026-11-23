/** When to ask the host to reopen the plugin (server restarted → old port/token dead): a 401, or a failed request
 *  whose health probe failed too (api.ts confirmLost); afterwards quiet for 10 s so a slow reopen isn't asked twice. */
export function reconnectPolicy(): (kind: "network" | "auth", now: number) => boolean {
  let lastAsk = -Infinity;
  return (_kind, now) => {
    if (now - lastAsk < 10_000) return false;
    lastAsk = now;
    return true;
  };
}
