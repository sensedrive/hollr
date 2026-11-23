import { expect, test } from "bun:test";
import { reconnectPolicy } from "../ui/reconnect";

test("401 asks at once, network only on the second failure within 5 s, then 10 s quiet", () => {
  const ask = reconnectPolicy();
  expect(ask("network", 0)).toBe(false);
  expect(ask("network", 6_000)).toBe(false); // first one too old
  expect(ask("network", 9_000)).toBe(true);
  expect(ask("auth", 12_000)).toBe(false); // within 10 s of the last ask
  expect(ask("auth", 19_000)).toBe(true);
});
