import { expect, test } from "bun:test";
import { reconnectPolicy } from "../ui/reconnect";

test("a confirmed loss asks at once, then stays quiet for 10 s", () => {
  const ask = reconnectPolicy();
  expect(ask("network", 0)).toBe(true);
  expect(ask("auth", 5_000)).toBe(false); // within 10 s of the last ask
  expect(ask("network", 10_000)).toBe(true);
});
