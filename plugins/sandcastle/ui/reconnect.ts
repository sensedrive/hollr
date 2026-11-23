/** When to ask the host to reopen the plugin (server restarted → old port/token dead): a 401, or two network
 *  failures within 5 s; afterwards quiet for 10 s. */
export function reconnectPolicy(): (kind: "network" | "auth", now: number) => boolean {
  let lastFail = -Infinity;
  let lastAsk = -Infinity;
  return (kind, now) => {
    const repeated = now - lastFail <= 5_000;
    lastFail = now;
    if (kind === "network" && !repeated) return false;
    if (now - lastAsk < 10_000) return false;
    lastAsk = now;
    return true;
  };
}
