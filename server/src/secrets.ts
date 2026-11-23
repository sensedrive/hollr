// Credentials stored on this machine for plugins and jobs (`secrets` gate). Tokens are written once
// by an app and never sent back: status answers without them, and nothing here logs them.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface JiraSecret {
  site: string;
  email: string;
  token: string;
  account: string | null;
  updatedAt: string;
}

export interface SecretsRequest {
  op?: string;
  name?: string;
  site?: string;
  email?: string;
  token?: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const secretsFile = () =>
  Bun.env.HOLLR_SECRETS_FILE ?? join(homedir(), ".config", "hollr", "secrets.json");

function load(): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(secretsFile(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function save(data: Record<string, unknown>) {
  const file = secretsFile();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function jira(): JiraSecret | null {
  const j = load().jira as JiraSecret | undefined;
  return j && typeof j.token === "string" && j.token ? j : null;
}

/** JIRA access for plugins and jobs on this machine, or null when none is stored. */
export function jiraCredentials(): { site: string; email: string; token: string } | null {
  const j = jira();
  return j ? { site: j.site, email: j.email, token: j.token } : null;
}

export function normalizeSite(site: string): string {
  return site.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** German error text for bad input, or null. */
export function validateJira(site: string, email: string, token: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(site))
    return "Ungültige JIRA-Adresse – erwartet z. B. firma.atlassian.net.";
  if (!email.includes("@")) return "Ungültige E-Mail-Adresse.";
  if (!token || token.length > 400 || /\s/.test(token))
    return "Ungültiges API-Token (1–400 Zeichen, ohne Leerzeichen).";
  return null;
}

export async function secrets(
  req: SecretsRequest,
  fetcher: Fetch = fetch,
): Promise<Record<string, unknown>> {
  if (req.op === "status" || !req.op) {
    const j = jira();
    return {
      jira: j ? { site: j.site, email: j.email, account: j.account ?? null, updatedAt: j.updatedAt } : null,
    };
  }
  if (req.name !== "jira") return { error: `Unbekanntes Geheimnis: ${req.name ?? ""}` };
  if (req.op === "delete") {
    const data = load();
    if ("jira" in data) {
      delete data.jira;
      save(data);
    }
    return { ok: true };
  }
  if (req.op !== "set") return { error: `Unbekannte Aktion: ${req.op}` };
  const site = normalizeSite(req.site ?? "");
  const email = (req.email ?? "").trim();
  const token = req.token ?? "";
  const bad = validateJira(site, email, token);
  if (bad) return { error: bad };
  let res: Response;
  try {
    res = await fetcher(`https://${site}/rest/api/3/myself`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { error: `JIRA nicht erreichbar: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 401 || res.status === 403)
    return { error: `JIRA lehnt die Anmeldung ab (${res.status}) – E-Mail oder Token prüfen.` };
  if (res.status !== 200) return { error: `JIRA nicht erreichbar: HTTP ${res.status}` };
  let account: string | null = null;
  try {
    const me = (await res.json()) as { displayName?: unknown };
    if (typeof me.displayName === "string") account = me.displayName;
  } catch {}
  const data = load();
  data.jira = { site, email, token, account, updatedAt: new Date().toISOString() } satisfies JiraSecret;
  save(data);
  return { ok: true, account };
}
