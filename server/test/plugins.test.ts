import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkPlugin, listPlugins, openPlugin, runningPid, stopPlugin, unlinkPlugin } from "../src/plugins";

const root = mkdtempSync(join(tmpdir(), "hollr-plugins-"));
const saved = { ...Bun.env };

const SERVER = `import { renameSync, writeFileSync } from "node:fs";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => new URL(req.url).pathname === "/__hollr/health" ? new Response("ok") : new Response("nope", { status: 404 }),
});
const ready = process.env.HOLLR_PLUGIN_READY_FILE ?? "";
writeFileSync(ready + ".tmp", JSON.stringify({ port: server.port, pid: process.pid }));
renameSync(ready + ".tmp", ready);
`;

function fixture(name: string, manifest: Record<string, unknown>, server?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hollr-plugin.json"), JSON.stringify(manifest));
  if (server !== undefined) writeFileSync(join(dir, "server.ts"), server);
  return dir;
}

const health = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/__hollr/health`)).status;
  } catch {
    return 0;
  }
};

beforeAll(() => {
  Bun.env.HOME = root;
  Bun.env.HOLLR_PLUGINS_FILE = join(root, "plugins.json");
  Bun.env.HOLLR_STATE_DIR = join(root, "state");
});

afterAll(() => {
  for (const id of ["demo", "mute"]) stopPlugin(id);
  for (const k of ["HOME", "HOLLR_PLUGINS_FILE", "HOLLR_STATE_DIR"]) {
    if (saved[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("plugin host", () => {
  test("link and list, a broken manifest shows as an error entry", () => {
    const dir = fixture("demo", { id: "demo", name: "Demo", version: "1.0.0", entry: "server.ts" }, SERVER);
    expect(linkPlugin(dir).id).toBe("demo");
    const broken = fixture("broken", { id: "broken", name: "Broken", version: "1", entry: "server.ts" }, SERVER);
    linkPlugin(broken);
    writeFileSync(join(broken, "hollr-plugin.json"), "{nope");
    const list = listPlugins();
    expect(list.find((p) => p.id === "demo")).toEqual({
      id: "demo",
      name: "Demo",
      description: undefined,
      version: "1.0.0",
    });
    const bad = list.find((p) => p.id === "broken");
    expect(bad?.name).toBe("broken");
    expect(bad?.error).toContain("JSON");
  });

  test("an entry outside the folder or through .. is refused", () => {
    const dir = fixture("escape", { id: "escape", name: "E", version: "1", entry: "../demo/server.ts" });
    expect(() => linkPlugin(dir)).toThrow("relativer Pfad");
    const sub = fixture("sub", { id: "sub", name: "S", version: "1", entry: "sub/../server.ts" }, SERVER);
    expect(() => linkPlugin(sub)).toThrow("relativer Pfad");
  });

  test("open starts once, a second open reuses the process, stop ends it", async () => {
    const first = await openPlugin("demo", [process.execPath]);
    expect(first.url).toMatch(new RegExp(`^http://localhost:${first.port}/#token=[0-9a-f]{64}$`));
    expect(await health(first.port)).toBe(200);
    const pid = runningPid("demo");
    expect(pid).toBeNumber();

    const second = await openPlugin("demo", [process.execPath]);
    expect(second).toEqual(first);
    expect(runningPid("demo")).toBe(pid as number);

    expect(stopPlugin("demo")).toBe(true);
    // SIGTERM is asynchronous: wait for the port to close, not a guessed duration
    let status = 200;
    for (let i = 0; i < 2000 && status === 200; i++) status = await health(first.port);
    expect(status).toBe(0);
  });

  test("unlink stops a running plugin even after its manifest broke", async () => {
    const dir = fixture("brittle", { id: "brittle", name: "Brittle", version: "1", entry: "server.ts" }, SERVER);
    linkPlugin(dir);
    const { port } = await openPlugin("brittle", [process.execPath]);
    writeFileSync(join(dir, "hollr-plugin.json"), "{nope");
    expect(unlinkPlugin("brittle")).toBe(true);
    let status = 200;
    for (let i = 0; i < 2000 && status === 200; i++) status = await health(port);
    expect(status).toBe(0);
  });

  test("a plugin that never gets ready fails with its log", async () => {
    const dir = fixture(
      "mute",
      { id: "mute", name: "Mute", version: "1", entry: "server.ts" },
      `console.error("kaputt beim Start"); setInterval(() => {}, 1000);\n`,
    );
    linkPlugin(dir);
    const err = await openPlugin("mute", [process.execPath]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("startet nicht");
    expect((err as Error).message).toContain("kaputt beim Start");
  }, 15_000);

  test("gate `plugins` lists the linked plugins", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "gate"], {
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        HOLLR_GATE_PATH: "1",
        HOLLR_AUTHORIZED_KEYS: join(root, "authorized_keys"),
        HOLLR_STATE_DIR: join(root, "state"),
        HOLLR_PLUGINS_FILE: join(root, "plugins.json"),
        XDG_STATE_HOME: root,
        XDG_CONFIG_HOME: root,
        SSH_ORIGINAL_COMMAND: "plugins",
      },
      stdin: new Blob(['{"op":"list"}\n']),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const res = JSON.parse(out) as { plugins: { id: string; name: string }[] };
    expect(res.plugins.find((p) => p.id === "demo")?.name).toBe("Demo");
  });
});
