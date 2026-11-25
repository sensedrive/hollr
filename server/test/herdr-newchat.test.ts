import { describe, expect, test } from "bun:test";
import { type Herdr, HerdrError, newChat } from "../src/herdr";

const herdr = {} as Herdr;
const created = { root_pane: { pane_id: "w2S:p1" }, workspace: { workspace_id: "w2S" } };

describe("newChat", () => {
  test("asks again while the fresh shell is busy, then starts the agent", async () => {
    const calls: string[][] = [];
    let busy = 2;
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "workspace") return created;
      if (args[0] === "agent" && busy-- > 0)
        throw new HerdrError(
          "agent_pane_busy",
          "agent target pane w2S:p1 is not an available shell",
        );
      return {};
    };
    const pane = await newChat(herdr, exec, {
      kind: "omp",
      cwd: "/tmp",
      label: "Sandcastle ilims",
      focus: false,
    });
    expect(pane).toBe("w2S:p1");
    expect(calls.filter((c) => c[0] === "agent")).toHaveLength(3);
    expect(calls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(false);
  });

  test("other refusals close the bare shell and fail at once", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "workspace") return created;
      if (args[0] === "agent") throw new HerdrError("unknown_kind", "nope");
      return {};
    };
    await expect(newChat(herdr, exec, { kind: "omp", cwd: "/tmp", focus: false })).rejects.toThrow(
      "nope",
    );
    expect(calls.filter((c) => c[0] === "agent")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["pane", "close", "w2S:p1"]);
  });
});
