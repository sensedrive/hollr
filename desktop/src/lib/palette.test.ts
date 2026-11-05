import { describe, expect, test } from "bun:test";
import { matchItems } from "./palette";

const items = [
  { label: "Settings", sub: undefined },
  { label: "api · fix login", sub: "hollr · Mac · working" },
  { label: "hollr", sub: "main · VM" },
  { label: "docs", sub: "hollr · Mac · new result" },
];
const labels = (q: string) => matchItems(items, q).map((i) => i.label);

describe("matchItems", () => {
  test("an empty query keeps everything in order", () => {
    expect(labels("  ")).toEqual(["Settings", "api · fix login", "hollr", "docs"]);
  });

  test("every word has to match, in label or sub line, in any order and case", () => {
    expect(labels("MAC hollr")).toEqual(["api · fix login", "docs"]);
    expect(labels("login mac")).toEqual(["api · fix login"]);
    expect(labels("vm mac")).toEqual([]);
  });

  test("label hits come before sub-line hits, the order stays otherwise", () => {
    expect(labels("hollr")).toEqual(["hollr", "api · fix login", "docs"]);
    expect(labels("o")).toEqual(["api · fix login", "hollr", "docs"]);
  });
});
