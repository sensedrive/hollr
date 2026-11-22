import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHidden, pruneHidden, setHidden } from "../src/hiddenspaces";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hollr-hidden-"));
  Bun.env.HOLLR_STATE_DIR = dir;
});
afterEach(() => {
  delete Bun.env.HOLLR_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("hiding and showing again is kept on the server, read by every later call", () => {
  expect(setHidden(["w3"], true)).toEqual(["w3"]);
  expect(setHidden(["w1"], true)).toEqual(["w1", "w3"]);
  expect([...loadHidden()].sort()).toEqual(["w1", "w3"]);
  expect(setHidden(["w3"], false)).toEqual(["w1"]);
  expect([...loadHidden()]).toEqual(["w1"]);
});

test("spaces herdr no longer has are forgotten – unless herdr lists none (restarting)", () => {
  setHidden(["w1", "w2"], true);
  expect([...pruneHidden([])].sort()).toEqual(["w1", "w2"]);
  expect([...pruneHidden(["w2", "w5"])]).toEqual(["w2"]);
  expect([...loadHidden()]).toEqual(["w2"]);
});
