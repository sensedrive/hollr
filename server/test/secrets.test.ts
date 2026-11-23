import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jiraCredentials, secrets } from "../src/secrets";

let dir: string;
let file: string;
const calls: { url: string; auth: string }[] = [];
const answer =
  (status: number, body: unknown = {}) =>
  async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? "" });
    return new Response(JSON.stringify(body), { status });
  };
const set = { op: "set", name: "jira", site: "https://acme.atlassian.net/", email: "a@b.de", token: "tok123" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hollr-secrets-"));
  file = join(dir, "cfg", "secrets.json");
  process.env.HOLLR_SECRETS_FILE = file;
  calls.length = 0;
});
afterEach(() => {
  delete process.env.HOLLR_SECRETS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("secrets", () => {
  test("validation rejects bad input without calling JIRA", async () => {
    const f = answer(200);
    expect((await secrets({ ...set, site: "evil.com" }, f)).error).toContain("JIRA-Adresse");
    expect((await secrets({ ...set, email: "nope" }, f)).error).toContain("E-Mail");
    expect((await secrets({ ...set, token: "a b" }, f)).error).toContain("Token");
    expect((await secrets({ ...set, token: "" }, f)).error).toContain("Token");
    expect((await secrets({ ...set, token: "x".repeat(401) }, f)).error).toContain("Token");
    expect(calls).toHaveLength(0);
  });

  test("401 stores nothing", async () => {
    const r = await secrets(set, answer(401));
    expect(r.error).toBe("JIRA lehnt die Anmeldung ab (401) – E-Mail oder Token prüfen.");
    expect(jiraCredentials()).toBeNull();
    expect(await secrets({ op: "status" })).toEqual({ jira: null });
  });

  test("network error", async () => {
    const r = await secrets(set, async () => {
      throw new Error("boom");
    });
    expect(r.error).toBe("JIRA nicht erreichbar: boom");
  });

  test("success stores 0600 in a 0700 dir; status hides the token", async () => {
    const r = await secrets(set, answer(200, { displayName: "Martin" }));
    expect(r).toEqual({ ok: true, account: "Martin" });
    expect(calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from("a@b.de:tok123").toString("base64")}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(jiraCredentials()).toEqual({ site: "acme.atlassian.net", email: "a@b.de", token: "tok123" });
    const status = await secrets({ op: "status" });
    expect(JSON.stringify(status)).not.toContain("tok123");
    expect(status.jira).toMatchObject({ site: "acme.atlassian.net", email: "a@b.de", account: "Martin" });
  });

  test("delete keeps other keys", async () => {
    await secrets(set, answer(200, { displayName: "M" }));
    const data = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...data, other: { x: 1 } }));
    expect(await secrets({ op: "delete", name: "jira" })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ other: { x: 1 } });
    expect(jiraCredentials()).toBeNull();
  });
});
