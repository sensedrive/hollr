import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandPath,
  FileRefused,
  IMAGE_LIMIT,
  paneContext,
  readPath,
  refusal,
  TEXT_LIMIT,
} from "../src/file";

// a fake home with a project in it, a fake temp folder and a folder outside both
let base: string;
let home: string;
let tmp: string;
let outside: string;
let project: string;
const ctx = (extra: { cwd?: string; root?: string } = {}) => ({ home, tmp: [tmp], ...extra });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FileRefused ? e.code : `other: ${e}`;
  }
  return "ok";
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "hollr-file-")));
  home = join(base, "home");
  tmp = join(base, "tmp");
  outside = join(base, "outside");
  project = join(home, "code", "app");
  for (const d of [
    tmp,
    outside,
    join(project, "src"),
    join(project, "test-results"),
    join(home, ".ssh"),
    join(home, ".config", "hollr"),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
  // 1×1 PNG
  writeFileSync(
    join(project, "test-results", "shot.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  writeFileSync(join(project, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(project, "big.log"), "x".repeat(TEXT_LIMIT + 10));
  writeFileSync(join(project, ".env"), "TOKEN=1\n");
  writeFileSync(join(project, ".env.example"), "TOKEN=\n");
  writeFileSync(join(project, "server.pem"), "-----BEGIN-----\n");
  writeFileSync(join(home, ".ssh", "config"), "Host x\n");
  writeFileSync(join(home, ".config", "hollr", "devices.json"), "{}");
  writeFileSync(join(tmp, "note.md"), "# hi\n");
  writeFileSync(join(outside, "secret.txt"), "nope\n");
  symlinkSync(join(outside, "secret.txt"), join(project, "sneaky.txt"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("file: resolving", () => {
  test("~, absolute, relative to the cwd, file:// URLs", () => {
    expect(expandPath("~", "/x", "/h")).toBe("/h");
    expect(expandPath("~/a/b.png", "/x", "/h")).toBe("/h/a/b.png");
    expect(expandPath("/abs/./c.ts", "/x", "/h")).toBe("/abs/c.ts");
    expect(expandPath("test-results/v.png", "/x/y", "/h")).toBe("/x/y/test-results/v.png");
    expect(expandPath("../z.md", "/x/y", "/h")).toBe("/x/z.md");
    expect(expandPath("file:///tmp/a%20b.png", "/x", "/h")).toBe("/tmp/a b.png");
  });

  test("relative to the pane's folder, then its space root; inSpace relative to the root", () => {
    const r = readPath("a.ts", ctx({ cwd: join(project, "src"), root: project }));
    expect(r.path).toBe(join(project, "src", "a.ts"));
    expect(r.inSpace).toBe("src/a.ts");
    // the agent sits in src/, the tool card path is space-relative
    const s = readPath("test-results/shot.png", ctx({ cwd: join(project, "src"), root: project }));
    expect(s.path).toBe(join(project, "test-results", "shot.png"));
    expect(readPath("~/code/app/src/a.ts", ctx()).inSpace).toBeUndefined();
    expect(readPath(join(tmp, "note.md"), ctx({ root: project })).inSpace).toBeUndefined();
  });

  test("no cwd: relative to home", () => {
    expect(readPath("code/app/src/a.ts", ctx()).path).toBe(join(project, "src", "a.ts"));
  });
});

describe("file: what may be read", () => {
  test("home and the temp folders only, symlinks checked at their target", () => {
    expect(code(() => readPath(join(tmp, "note.md"), ctx()))).toBe("ok");
    expect(code(() => readPath(join(outside, "secret.txt"), ctx()))).toBe("outside");
    expect(code(() => readPath(join(outside, "missing.txt"), ctx()))).toBe("outside");
    expect(code(() => readPath("/etc/hosts", ctx()))).toBe("outside");
    expect(code(() => readPath(join(project, "sneaky.txt"), ctx()))).toBe("outside");
    expect(code(() => readPath("../../../outside/secret.txt", ctx({ cwd: project })))).toBe(
      "outside",
    );
    expect(code(() => readPath(join(project, "nope.ts"), ctx()))).toBe("not_found");
    expect(code(() => readPath("", ctx()))).toBe("not_found");
  });

  test("keys, credentials and Hollr's own state are refused", () => {
    expect(code(() => readPath("~/.ssh/config", ctx()))).toBe("secret");
    expect(code(() => readPath("~/.ssh", ctx()))).toBe("secret");
    expect(code(() => readPath("~/.config/hollr/devices.json", ctx()))).toBe("secret");
    expect(code(() => readPath(join(project, ".env"), ctx()))).toBe("secret");
    expect(code(() => readPath(join(project, "server.pem"), ctx()))).toBe("secret");
    expect(code(() => readPath(join(project, ".env.example"), ctx()))).toBe("ok");
    for (const name of [
      "id_ed25519",
      "id_rsa",
      ".netrc",
      ".git-credentials",
      ".credentials.json",
      "auth.json",
      ".env.local",
      "agent.db",
    ])
      expect(refusal(join(home, "x", name), home, [tmp])).toBe("secret");
    for (const name of ["id_ed25519.pub", "keys.ts", "environment.md", "credentials.md"])
      expect(refusal(join(home, "x", name), home, [tmp])).toBeUndefined();
  });
});

describe("file: kinds", () => {
  test("image as base64 with its mime type", () => {
    const r = readPath(join(project, "test-results", "shot.png"), ctx());
    expect(r.kind).toBe("image");
    expect(r.mime).toBe("image/png");
    expect(
      Buffer.from(r.data ?? "", "base64")
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
    expect(r.truncated).toBe(false);
    expect(r.name).toBe("shot.png");
    expect(IMAGE_LIMIT).toBe(15 * 1024 * 1024);
  });

  test("text, binary, a long text cut", () => {
    const t = readPath(join(project, "src", "a.ts"), ctx());
    expect(t).toMatchObject({
      kind: "text",
      text: "export const a = 1;\n",
      truncated: false,
      size: 20,
    });
    expect(t.mtime).toBeGreaterThan(0);
    expect(readPath(join(project, "blob.bin"), ctx())).toMatchObject({
      kind: "binary",
      truncated: false,
    });
    expect(readPath(join(project, "blob.bin"), ctx()).text).toBeUndefined();
    const big = readPath(join(project, "big.log"), ctx());
    expect(big.kind).toBe("text");
    expect(big.truncated).toBe(true);
    expect(big.text?.length).toBe(TEXT_LIMIT);
  });

  test("folder: a listing, folders first", () => {
    const d = readPath("~/code/app", ctx({ root: project }));
    expect(d.kind).toBe("dir");
    expect(d.inSpace).toBe("");
    expect(d.entries?.slice(0, 2)).toEqual([
      { name: "src", dir: true, size: 0 },
      { name: "test-results", dir: true, size: 0 },
    ]);
    expect(d.entries?.some((e) => e.name === "a.ts")).toBe(false);
    expect(d.entries?.find((e) => e.name === "blob.bin")?.size).toBe(4);
  });
});

describe("file: pane context from herdr", () => {
  test("foreground cwd first, the workspace's root for inSpace", async () => {
    const exec = async (args: string[]) => {
      if (args[0] === "pane" && args[1] === "get")
        return { pane: { foreground_cwd: join(project, "src"), cwd: project, workspace_id: "w1" } };
      if (args[0] === "workspace")
        return {
          workspaces: [
            { workspace_id: "w1", label: "app", number: 1, worktree: { checkout_path: project } },
          ],
        };
      if (args[0] === "pane") return { panes: [] };
      return {};
    };
    expect(await paneContext("w1:p1", exec)).toEqual({ cwd: join(project, "src"), root: project });
    expect(await paneContext("", exec)).toEqual({});
  });
});
