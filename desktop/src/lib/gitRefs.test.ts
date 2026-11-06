import { describe, expect, test } from "bun:test";
import { parseRefs } from "./gitRefs";

describe("parseRefs", () => {
  test("with the repo's remotes: remote-tracking branches by remote name, slashed local branches stay local", () => {
    expect(parseRefs("HEAD -> main, tag: v1, origin/main, origin/HEAD, feature/x, upstream/release/v1", ["origin", "upstream"])).toEqual([
      { name: "main", kind: "head" },
      { name: "v1", kind: "tag" },
      { name: "origin/main", kind: "remote", remote: "origin" },
      { name: "feature/x", kind: "local" },
      { name: "upstream/release/v1", kind: "remote", remote: "upstream" },
    ]);
  });
  test("older servers without remotes: a slash means remote", () => {
    expect(parseRefs("main, origin/release-prep/v1.1")).toEqual([
      { name: "main", kind: "local" },
      { name: "origin/release-prep/v1.1", kind: "remote", remote: "origin" },
    ]);
  });
  test("nothing decorated", () => {
    expect(parseRefs(undefined, ["origin"])).toEqual([]);
    expect(parseRefs("HEAD")).toEqual([]);
  });
});
