import { describe, expect, test } from "bun:test";
import { parseRange, satisfies } from "../src/semver";

describe("lulWorkr ranges", () => {
  test("caret: same major from 1.x on, same minor below 1.0", () => {
    expect(satisfies("1.1.0", "^1.1")).toBe(true);
    expect(satisfies("1.9.3", "^1.1")).toBe(true);
    expect(satisfies("1.0.9", "^1.1")).toBe(false);
    expect(satisfies("2.0.0", "^1.1")).toBe(false);
    expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
    expect(satisfies("0.2.5", "^0.2")).toBe(true);
    expect(satisfies("0.3.0", "^0.2")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  test("tilde: same minor", () => {
    expect(satisfies("1.1.7", "~1.1")).toBe(true);
    expect(satisfies("1.1.0", "~1.1.0")).toBe(true);
    expect(satisfies("1.2.0", "~1.1.0")).toBe(false);
    expect(satisfies("1.9.0", "~1")).toBe(true);
    expect(satisfies("2.0.0", "~1")).toBe(false);
  });

  test("exact and partial versions", () => {
    expect(satisfies("1.1.0", "1.1.0")).toBe(true);
    expect(satisfies("1.1.0", "=1.1.0")).toBe(true);
    expect(satisfies("1.1.1", "1.1.0")).toBe(false);
    expect(satisfies("v1.1.0", "1.1.0")).toBe(true);
    expect(satisfies("1.1.4", "1.1")).toBe(true);
    expect(satisfies("1.1.4", "1.1.x")).toBe(true);
    expect(satisfies("1.2.0", "1.1")).toBe(false);
    expect(satisfies("3.0.0", "*")).toBe(true);
  });

  test("comparators, and, or", () => {
    expect(satisfies("1.4.0", ">=1.1.0 <2")).toBe(true);
    expect(satisfies("2.0.0", ">=1.1.0 <2")).toBe(false);
    expect(satisfies("2.1.0", "^1.1 || ^2.1")).toBe(true);
    expect(satisfies("2.0.0", "^1.1 || ^2.1")).toBe(false);
    expect(satisfies("1.2.0", ">1.1")).toBe(true);
    expect(satisfies("1.1.9", ">1.1")).toBe(false);
  });

  test("pre-releases only through a bound of the same core version", () => {
    expect(satisfies("1.2.0-rc.1", "^1.1")).toBe(false);
    expect(satisfies("1.2.0-rc.1", "^1.2.0-rc.0")).toBe(true);
    expect(satisfies("2.0.0-rc.1", "^1.1")).toBe(false);
  });

  test("unreadable is never satisfied", () => {
    expect(parseRange("^banana")).toBeNull();
    expect(satisfies("1.1.0", "^banana")).toBe(false);
    expect(satisfies("installiert", "^1.1")).toBe(false);
    expect(satisfies("1.1", "^1.1")).toBe(false);
  });
});
