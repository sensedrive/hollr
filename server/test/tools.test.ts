import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lulWorkrLatest, startTool, toolStates } from "../src/tools";

let home: string;
let oldHome: string | undefined;
let oldPath: string | undefined;
const bin = () => join(home, ".local", "bin");
const lulState = () =>
  toolStates("1.0.0", {}, "de", () => ({})).find((t) => t.name === "lul-workr");

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  oldHome = process.env.HOME;
  oldPath = process.env.PATH;
  home = mkdtempSync(join(tmpdir(), "hollr-lul-"));
  mkdirSync(bin(), { recursive: true });
  process.env.HOME = home;
  // the machine's own ~/.local/bin (a real lul-workr) must not answer for the temp HOME
  process.env.PATH = "/usr/bin:/bin";
});
afterAll(() => {
  process.env.HOME = oldHome;
  process.env.PATH = oldPath;
  rmSync(home, { recursive: true, force: true });
});

describe("lul-workr tool", () => {
  test("comes after claude/omp, not installed without the shim", () => {
    const states = toolStates("1.0.0", {}, "de", () => ({
      error: "gh fehlt – neueste lul-workr-Version unbekannt",
    }));
    const names = states.map((t) => t.name);
    expect(names.indexOf("lul-workr")).toBeGreaterThan(names.indexOf("claude"));
    const s = states.find((t) => t.name === "lul-workr");
    console.log("not-installed", JSON.stringify(s));
    expect(s).toMatchObject({
      title: "lul-workr",
      installed: false,
      running: false,
      latestError: expect.stringContaining("gh fehlt"),
    });
  });

  test("latest via gh; missing or logged-out gh explains why it is unknown", () => {
    const gh = join(home, "gh-ok");
    script(gh, 'case "$1" in api) echo v1.3.0;; esac');
    expect(lulWorkrLatest(gh)).toEqual({ latest: "1.3.0" });
    expect(lulWorkrLatest(undefined).error).toContain("gh fehlt");
    const out = join(home, "gh-out");
    script(out, "exit 1");
    expect(lulWorkrLatest(out).error).toContain("nicht angemeldet");
  });

  test("install script: fake release → shim, skills link --fix, doctor", async () => {
    // fake release tarball following the bundle contract
    const rel = join(home, "rel");
    const top = join(rel, "lul-workr-1.2.0");
    mkdirSync(join(top, "bin"), { recursive: true });
    writeFileSync(
      join(top, "bin", "lul-workr.mjs"),
      `import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
const b = process.env.HOME + "/.local/bin"; mkdirSync(b, { recursive: true });
writeFileSync(b + "/lul-workr", '#!/bin/sh\\nif [ "$1" = --version ]; then echo 1.2.0; else echo "lul-workr $*" >> "$HOME/calls"; fi\\n');
chmodSync(b + "/lul-workr", 0o755);
console.log("installed", process.argv.slice(2).join(" "));\n`,
    );
    Bun.spawnSync([
      "tar",
      "-czf",
      join(home, "lul-workr-1.2.0.tar.gz"),
      "-C",
      rel,
      "lul-workr-1.2.0",
    ]);
    script(
      join(bin(), "gh"),
      `case "$1" in
api) echo v1.2.0;;
release) shift; while [ $# -gt 0 ]; do [ "$1" = -D ] && D="$2"; shift; done; cp "${home}/lul-workr-1.2.0.tar.gz" "$D/";;
esac`,
    );
    startTool("lul-workr", "1.0.0");
    const exitFile = join(home, ".local", "state", "hollr", "tools", "lul-workr.exit");
    // detached process: its exit file is the only completion signal, so poll real time
    for (let i = 0; i < 100; i++) {
      try {
        readFileSync(exitFile);
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    const s = lulState();
    expect(s?.exit, s?.log).toBe(0);
    expect(readFileSync(join(home, "calls"), "utf8")).toBe(
      "lul-workr skills link --fix\nlul-workr doctor\n",
    );
    const installed = toolStates("1.0.0", { "lul-workr": "1.2.0" }).find(
      (t) => t.name === "lul-workr",
    );
    console.log("installed", JSON.stringify({ ...installed, log: undefined }));
    expect(installed).toMatchObject({
      installed: true,
      version: "1.2.0",
      latest: "1.2.0",
      updateAvailable: false,
    });
    const update = toolStates("1.0.0", { "lul-workr": "1.3.0" }).find(
      (t) => t.name === "lul-workr",
    );
    console.log("update-available", JSON.stringify({ ...update, log: undefined }));
    expect(update).toMatchObject({
      installed: true,
      version: "1.2.0",
      latest: "1.3.0",
      updateAvailable: true,
    });
  });
});
