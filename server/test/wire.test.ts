import { describe, expect, test } from "bun:test";
import { wireJson } from "../src/wire";

describe("wireJson", () => {
  test("a string cut inside an emoji stays valid for strict JSON parsers", () => {
    const cut = "Selected 🔖".slice(0, -1); // the high surrogate alone
    const text = wireJson({ items: [{ text: cut }] });
    expect(text).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(text).items[0].text).toBe("Selected \ufffd");
  });
  test("whole emoji and plain text are untouched", () => {
    expect(wireJson({ a: "🔖 ok", b: 1 })).toBe(JSON.stringify({ a: "🔖 ok", b: 1 }));
  });
});
