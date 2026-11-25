import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandcastle } from "../src/sandcastle";
import {
  type CheckItem,
  jobState,
  packageManagerOf,
  projectsParent,
  type SetupDeps,
  type SetupFileInfo,
  type SetupJob,
  sandcastleSetup,
  secretsOf,
  slugOfRemote,
  validSlug,
} from "../src/sandcastlesetup";

// two machines: `source` has the project, `target` only another one; each its own HOME and state dir
const root = realpathSync(mkdtempSync(join(tmpdir(), "hollr-setup-")));
const source = join(root, "source");
const target = join(root, "target");
const fakes = join(root, "bin");
const SLUG = "acme/shop";
const SECRET = "sk-ant-oat01-SECRETVALUE";
const saved = {
  HOME: Bun.env.HOME,
  HOLLR_STATE_DIR: Bun.env.HOLLR_STATE_DIR,
};

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function on(machine: string) {
  Bun.env.HOME = machine;
  Bun.env.HOLLR_STATE_DIR = join(machine, "state");
}

function fake(name: string, body: string) {
  writeFileSync(join(fakes, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// every command the setup runs is a fake – no real gh, docker or package manager is ever asked
const deps: SetupDeps = {
  bin: (n) => (["gh", "docker", "node", "yarn", "omp"].includes(n) ? join(fakes, n) : undefined),
};
const call = <T>(req: Record<string, unknown>, d: SetupDeps = deps) =>
  sandcastleSetup(req, d) as Promise<T>;

// the job is a real detached process (setsid + sh) that only reports through its exit file: poll for that file
async function settle(slug: string, kind: SetupJob["kind"]): Promise<SetupJob> {
  for (let i = 0; i < 100; i++) {
    const s = jobState(slug, kind);
    if (s && !s.running) return s;
    await Bun.sleep(100);
  }
  throw new Error(`${kind} läuft noch`);
}

const shopConfig = (slug = SLUG) =>
  JSON.stringify({ project: "shop", repo: { slug }, engine: { kind: "sandcastle" } });
const DOT_ENV = "# local\nDATABASE_URL=postgres://u:pw@db/shop\nPORT=3000\n";
const SANDCASTLE_ENV = `CLAUDE_CODE_OAUTH_TOKEN=${SECRET}\nEMPTY=\n`;

beforeAll(() => {
  mkdirSync(fakes, { recursive: true });
  fake(
    "gh",
    `case "$1 $2" in
  "repo clone") mkdir -p "$4" && cd "$4" && git init -q -b main && git remote add origin "https://github.com/$3.git" \\
    && printf '{"name":"shop","packageManager":"yarn@4.12.0"}' > package.json && : > yarn.lock && echo "Cloning into '$4'..." ;;
  "auth status") echo "github.com" >&2; echo "  ✓ Logged in to github.com account tester (keyring)" >&2 ;;
  *) exit 1 ;;
esac`,
  );
  fake("docker", `[ "$1" = info ] && echo 27.3.1`);
  fake("node", "echo v22.17.1");
  fake("omp", "echo 14.2.0");
  fake(
    "yarn",
    `if [ "$1" = --version ]; then echo 4.12.0; else echo "args: $*"; mkdir -p node_modules; echo "➤ YN0000: Done"; fi`,
  );

  // source: the project with its untracked files
  const shop = join(source, "code", "shop");
  mkdirSync(join(shop, ".sandcastle"), { recursive: true });
  writeFileSync(join(shop, ".lul-workr.json"), shopConfig());
  writeFileSync(join(shop, ".env"), DOT_ENV);
  writeFileSync(join(shop, ".sandcastle", ".env"), SANDCASTLE_ENV);
  git(shop, "init", "-q", "-b", "main");
  git(shop, "remote", "add", "origin", `git@github.com:${SLUG}.git`);

  // target: one other project under ~/work → clones go to ~/work
  const other = join(target, "work", "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, ".lul-workr.json"), shopConfig("acme/other"));
  git(other, "init", "-q");
});

afterAll(() => {
  Bun.env.HOME = saved.HOME;
  if (saved.HOLLR_STATE_DIR === undefined) delete Bun.env.HOLLR_STATE_DIR;
  else Bun.env.HOLLR_STATE_DIR = saved.HOLLR_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("pure parts", () => {
  test("slug: owner/repo only, no traversal, no .git", () => {
    expect(validSlug(" acme/shop ")).toBe("acme/shop");
    for (const bad of ["acme", "acme/..", "acme/.", "../x", "acme/shop/x", "acme/shop.git", "a b/c", 7])
      expect(() => validSlug(bad)).toThrow("Ungültiger Repo-Name");
  });

  test("projects folder: the most common parent, else ~/projects", () => {
    expect(projectsParent(["/h/a/x", "/h/a/y", "/h/b/z"], "/h")).toBe("/h/a");
    expect(projectsParent([], "/h")).toBe("/h/projects");
  });

  test("remote URLs of every form name the slug", () => {
    expect(slugOfRemote("https://github.com/Acme/Shop.git")).toBe("acme/shop");
    expect(slugOfRemote("git@github.com:acme/shop.git\n")).toBe("acme/shop");
    expect(slugOfRemote("ssh://git@github.com/acme/shop")).toBe("acme/shop");
    expect(slugOfRemote("https://gitlab.com/acme/shop.git")).toBeNull();
  });

  test("secrets: env files with values are secret, key names only", () => {
    expect(secretsOf(".env", "A=1\nAPI_KEY='x'\nDB=postgres://u:p@h/d\nEMPTY=\n# TOKEN=x")).toEqual({
      secret: true,
      keys: ["API_KEY", "DB"],
    });
    expect(secretsOf(".sandcastle/.env", "# nur Kommentar\nX=\n")).toEqual({ secret: false, keys: [] });
    expect(
      secretsOf(".lul-workr.json", JSON.stringify({ jira: { apiToken: "t", baseUrl: "u" }, x: [{ password: "p" }] })),
    ).toEqual({ secret: true, keys: ["jira.apiToken", "x[0].password"] });
    expect(secretsOf(".lul-workr.json", shopConfig())).toEqual({ secret: false, keys: [] });
  });

  test("package manager from the lockfile", () => {
    const d = join(root, "pm");
    mkdirSync(d, { recursive: true });
    expect(packageManagerOf(d)).toBeNull();
    writeFileSync(join(d, "package.json"), `{"packageManager":"yarn@4.12.0"}`);
    writeFileSync(join(d, "yarn.lock"), "");
    expect(packageManagerOf(d)).toEqual({ name: "yarn", lockfile: "yarn.lock", version: "4.12.0", berry: true });
    writeFileSync(join(d, "pnpm-lock.yaml"), "");
    expect(packageManagerOf(d)).toMatchObject({ name: "pnpm", version: null, berry: false });
  });
});

describe("source machine", () => {
  test("setup-files lists the whitelist with sizes and secret key names, no contents", async () => {
    on(source);
    const r = await call<{ files: SetupFileInfo[] }>({ op: "setup-files", slug: SLUG });
    expect(r.files).toEqual([
      { path: ".lul-workr.json", exists: true, size: shopConfig().length, secret: false, keys: [] },
      { path: ".env", exists: true, size: DOT_ENV.length, secret: true, keys: ["DATABASE_URL"] },
      {
        path: ".sandcastle/.env",
        exists: true,
        size: SANDCASTLE_ENV.length,
        secret: true,
        keys: ["CLAUDE_CODE_OAUTH_TOKEN"],
      },
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("setup-files-read returns only whitelisted files", async () => {
    on(source);
    const r = await call<{ files: { path: string; content: string }[] }>({
      op: "setup-files-read",
      slug: SLUG,
      paths: [".sandcastle/.env", ".lul-workr.json"],
    });
    expect(r.files.map((f) => f.path)).toEqual([".sandcastle/.env", ".lul-workr.json"]);
    expect(r.files[0]?.content).toContain(SECRET);
    for (const bad of ["../.ssh/id_rsa", ".git/config", "/etc/passwd", ".env.local"])
      await expect(call({ op: "setup-files-read", slug: SLUG, paths: [bad] })).rejects.toThrow(
        "wird nicht kopiert",
      );
    await expect(call({ op: "setup-files-read", slug: "acme/none", paths: [".env"] })).rejects.toThrow(
      "nicht geklont",
    );
  });
});

describe("target machine", () => {
  const clone = join(target, "work", "shop");
  const expectFiles = [".lul-workr.json", ".env", ".sandcastle/.env"];
  const check = async () =>
    call<{ path: string; cloned: boolean; known: boolean; items: CheckItem[] }>({
      op: "setup-check",
      slug: SLUG,
      expect: expectFiles,
    });
  const byId = (items: CheckItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));

  test("before the clone: the checklist offers it and names the projects folder", async () => {
    on(target);
    const r = await check();
    expect(r).toMatchObject({ path: clone, cloned: false, known: false });
    const items = byId(r.items);
    expect(items.checkout).toMatchObject({ ok: false, fix: "clone" });
    expect(items.docker).toMatchObject({ ok: true, detail: "Server 27.3.1" });
    expect(items.gh).toMatchObject({ ok: true, detail: "angemeldet als tester" });
    expect(items.central).toMatchObject({ ok: false, fix: null });
  });

  test("setup-clone runs gh repo clone detached; a second clone refuses the existing folder", async () => {
    on(target);
    const r = await call<{ path: string; job: SetupJob }>({ op: "setup-clone", slug: SLUG });
    expect(r.path).toBe(clone);
    const job = await settle(SLUG, "clone");
    expect(job.exit).toBe(0);
    expect(job.log).toContain("Cloning into");
    expect(existsSync(join(clone, ".git"))).toBe(true);
    await expect(call({ op: "setup-clone", slug: SLUG })).rejects.toThrow("gibt es schon – nicht überschrieben");
  });

  test("setup-clone refuses a project the machine already has", async () => {
    on(target);
    await expect(call({ op: "setup-clone", slug: "acme/other" })).rejects.toThrow("schon ausgecheckt");
  });

  test("setup-files-write: env files 600, config 644, never over an existing file without overwrite", async () => {
    on(source);
    const read = await call<{ files: { path: string; content: string }[] }>({
      op: "setup-files-read",
      slug: SLUG,
      paths: expectFiles,
    });
    on(target);
    const w = await call<{ written: { path: string; mode: string }[] }>({
      op: "setup-files-write",
      slug: SLUG,
      files: read.files,
    });
    expect(w.written.map((f) => [f.path, f.mode])).toEqual([
      [".lul-workr.json", "644"],
      [".env", "600"],
      [".sandcastle/.env", "600"],
    ]);
    expect(statSync(join(clone, ".sandcastle", ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(clone, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(clone, ".sandcastle", ".env"), "utf8")).toContain(SECRET);
    const again = { op: "setup-files-write", slug: SLUG, files: [{ path: ".env", content: "X=2\n" }] };
    await expect(call(again)).rejects.toThrow(".env gibt es auf");
    expect(readFileSync(join(clone, ".env"), "utf8")).toContain("DATABASE_URL");
    await call({ ...again, overwrite: true });
    expect(readFileSync(join(clone, ".env"), "utf8")).toBe("X=2\n");
    expect(statSync(join(clone, ".env")).mode & 0o777).toBe(0o600);
  });

  test("setup-files-write validates everything before writing anything", async () => {
    on(target);
    const write = (files: unknown[], overwrite = true) =>
      call({ op: "setup-files-write", slug: SLUG, files, overwrite });
    await expect(write([{ path: "../evil", content: "x" }])).rejects.toThrow("wird nicht kopiert");
    await expect(write([{ path: ".git/hooks/pre-commit", content: "x" }])).rejects.toThrow("wird nicht kopiert");
    await expect(write([{ path: ".lul-workr.json", content: shopConfig("acme/evil") }])).rejects.toThrow(
      "gehört zu acme/evil",
    );
    await expect(write([{ path: ".lul-workr.json", content: "{nope" }])).rejects.toThrow("kein gültiges JSON");
    // a bad second file stops the first one too
    await expect(
      write([
        { path: ".env", content: "NEU=1\n" },
        { path: ".env", content: "NEU=2\n" },
      ]),
    ).rejects.toThrow("doppelt");
    expect(readFileSync(join(clone, ".env"), "utf8")).toBe("X=2\n");
    await expect(write([{ path: ".env", content: "x".repeat(70_000) }])).rejects.toThrow("64 KiB");
    await expect(write([{ path: ".env", content: "X=1" }], true).then(() => "ok")).resolves.toBe("ok");
  });

  test("a symlinked .sandcastle is never written through", async () => {
    on(target);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const side = join(clone, ".sandcastle");
    rmSync(side, { recursive: true, force: true });
    symlinkSync(outside, side);
    await expect(
      call({ op: "setup-files-write", slug: SLUG, files: [{ path: ".sandcastle/.env", content: "A=1" }], overwrite: true }),
    ).rejects.toThrow("symbolischer Link");
    expect(existsSync(join(outside, ".env"))).toBe(false);
    rmSync(side);
    await call({ op: "setup-files-write", slug: SLUG, files: [{ path: ".sandcastle/.env", content: "A=1" }] });
  });

  test("setup-install runs the lockfile's package manager detached; the checklist then passes", async () => {
    on(target);
    expect(byId((await check()).items).deps).toMatchObject({ ok: false, detail: "node_modules fehlt", fix: "install" });
    const r = await call<{ pm: { name: string }; job: SetupJob }>({ op: "setup-install", slug: SLUG });
    expect(r.pm.name).toBe("yarn");
    const job = await settle(SLUG, "install");
    expect(job.exit).toBe(0);
    expect(job.log).toContain("args: install --immutable");
    mkdirSync(join(target, ".config"), { recursive: true });
    writeFileSync(join(target, ".config", "sandcastle.env"), "X=1\n");
    const items = byId((await check()).items);
    expect(items.deps).toMatchObject({ ok: true });
    expect(items.pm).toMatchObject({ ok: true, detail: "yarn 4.12.0 (yarn.lock)" });
    expect(items.node).toMatchObject({ ok: true, detail: "22.17.1" });
    expect(items.agent).toMatchObject({ ok: true });
    expect(items.agent?.detail).toContain("omp 14.2.0 (Lauf-Sitzung)");
    expect(items["file:.sandcastle/.env"]).toMatchObject({ ok: true });
    expect(items.central).toMatchObject({ ok: true, detail: "vorhanden (wird nie kopiert)" });
    // the clone's origin/main has no queue.mts
    expect(items.queue).toMatchObject({ ok: false });
  });

  test("after the files, a project rescan finds the clone", async () => {
    on(target);
    const { projects } = (await sandcastle({ op: "projects", refresh: true }, {})) as {
      projects: { slug: string; root: string }[];
    };
    expect(projects.find((p) => p.slug === SLUG)?.root).toBe(clone);
    expect((await check()).known).toBe(true);
  });

  test("the gate logs op and slug of setup writes and reads, never file contents", async () => {
    const gate = async (machine: string, stdin: unknown) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "gate"], {
        env: {
          PATH: Bun.env.PATH ?? "/usr/bin:/bin",
          HOME: machine,
          HOLLR_GATE_PATH: "1",
          HOLLR_AUTHORIZED_KEYS: join(machine, "authorized_keys"),
          HOLLR_STATE_DIR: join(machine, "state"),
          XDG_STATE_HOME: join(machine, "xdg"),
          XDG_CONFIG_HOME: join(machine, "xdg"),
          SSH_ORIGINAL_COMMAND: "sandcastle",
        },
        stdin: new TextEncoder().encode(`${JSON.stringify(stdin)}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return JSON.parse(out) as { files?: { content: string }[]; error?: string };
    };
    const read = await gate(source, { op: "setup-files-read", slug: SLUG, paths: [".sandcastle/.env"] });
    expect(read.files?.[0]?.content).toContain(SECRET);
    const wrote = await gate(target, {
      op: "setup-files-write",
      slug: SLUG,
      files: [{ path: ".sandcastle/.env", content: `TOKEN=${SECRET}\n` }],
      overwrite: true,
    });
    expect(wrote.error).toBeUndefined();
    // refused writes don't echo the content either
    const refused = await gate(target, {
      op: "setup-files-write",
      slug: SLUG,
      files: [{ path: ".env", content: `TOKEN=${SECRET}\n` }],
    });
    expect(refused.error).toContain("nicht überschrieben");
    expect(refused.error).not.toContain(SECRET);
    const logs = [source, target].map((m) => readFileSync(join(m, "xdg", "hollr", "hollr.log"), "utf8"));
    expect(logs[0]).toContain("sandcastle setup-files-read acme/shop");
    expect(logs[1]).toContain("sandcastle setup-files-write acme/shop");
    for (const text of logs) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("content");
    }
  });
});
