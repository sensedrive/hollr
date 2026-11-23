import { describe, expect, test } from "bun:test";
import { parseHostRequest } from "./pluginHost";

const allow = ["sandcastle"];

describe("parseHostRequest", () => {
  test("ignores foreign messages", () => {
    expect(parseHostRequest(null, allow)).toBeUndefined();
    expect(parseHostRequest({ type: "hollr-open-url", url: "https://x" }, allow)).toBeUndefined();
    expect(parseHostRequest({ hollr: 1, type: "servers" }, allow)).toBeUndefined();
    expect(parseHostRequest({ hollr: 1, id: "1", type: "nope" }, allow)).toBeUndefined();
  });

  test("servers and open-session", () => {
    expect(parseHostRequest({ hollr: 1, id: "1", type: "servers" }, allow)).toEqual({ type: "servers", id: "1" });
    expect(parseHostRequest({ hollr: 1, type: "open-session", server: "s", pane: "w1:p2" }, allow)).toEqual({
      type: "open-session",
      server: "s",
      pane: "w1:p2",
    });
    expect(parseHostRequest({ hollr: 1, type: "open-session", server: "s" }, allow)).toBeUndefined();
  });

  test("gate honours the allowlist and needs an object stdin", () => {
    expect(parseHostRequest({ hollr: 1, id: "2", type: "gate", server: "s", command: "sandcastle", stdin: { op: "x" } }, allow))
      .toEqual({ type: "gate", id: "2", server: "s", command: "sandcastle", stdin: { op: "x" } });
    expect(parseHostRequest({ hollr: 1, id: "3", type: "gate", server: "s", command: "fs", stdin: {} }, allow)).toMatchObject({
      type: "reject",
      id: "3",
    });
    expect(parseHostRequest({ hollr: 1, id: "4", type: "gate", server: "s", command: "sandcastle", stdin: [1] }, allow))
      .toMatchObject({ type: "reject" });
    expect(parseHostRequest({ hollr: 1, id: "5", type: "gate", server: "s", command: "sandcastle", stdin: {} }, [])).toMatchObject({
      type: "reject",
    });
  });
});
