// Ref chips of the history graph (pure: no app state, testable on its own).

/** `%D` decoration → chips: "HEAD -> main, origin/main, tag: v1". `remote` = the remote's name of a
 *  remote-tracking branch (`origin` for `origin/main`); with the repo's `remotes` known, a local
 *  `feature/x` stays local – without them (older servers), any name with a slash counts as remote. */
export interface Ref { name: string; kind: "head" | "local" | "remote" | "tag"; remote?: string }
export function parseRefs(refs?: string, remotes?: string[]): Ref[] {
  if (!refs) return [];
  const out: Ref[] = [];
  for (const raw of refs.split(", ")) {
    const r = raw.trim();
    if (!r || r === "HEAD" || r.endsWith("/HEAD")) continue;
    if (r.startsWith("HEAD -> ")) out.push({ name: r.slice(8), kind: "head" });
    else if (r.startsWith("tag: ")) out.push({ name: r.slice(5), kind: "tag" });
    else {
      const remote = remotes ? remotes.find((x) => r.startsWith(`${x}/`)) : r.includes("/") ? r.split("/")[0] : undefined;
      out.push(remote ? { name: r, kind: "remote", remote } : { name: r, kind: "local" });
    }
  }
  return out;
}
