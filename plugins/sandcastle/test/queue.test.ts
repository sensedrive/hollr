import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, effectiveOrder, moveBefore, readOrder, remove, writeOrder } from "../src/queue";

describe("effectiveOrder", () => {
  test("keeps the stored order of queued issues, drops gone ones, adds new ones ascending", () => {
    // 9 is closed / lost its label, 3 and 8 are new
    expect(effectiveOrder([5, 9, 1], [8, 1, 3, 5])).toEqual([5, 1, 3, 8]);
  });

  test("duplicates in the file count once", () => {
    expect(effectiveOrder([2, 2, 1], [1, 2])).toEqual([2, 1]);
  });

  test("the loop's example: order [5,3], queued [3,5,7] → 5,3,7", () => {
    expect(effectiveOrder([5, 3], [3, 5, 7])).toEqual([5, 3, 7]);
  });
});

describe("moveBefore", () => {
  const order = [1, 2, 3, 4];
  test("to the front, the middle, the end", () => {
    expect(moveBefore(order, 4, 1)).toEqual([4, 1, 2, 3]);
    expect(moveBefore(order, 1, 3)).toEqual([2, 1, 3, 4]);
    expect(moveBefore(order, 2, null)).toEqual([1, 3, 4, 2]);
  });

  test("before itself: unchanged", () => {
    expect(moveBefore(order, 3, 3)).toEqual(order);
  });
});

describe("append / remove", () => {
  test("append moves an already queued issue to the end", () => {
    expect(append([1, 2, 3], 1)).toEqual([2, 3, 1]);
    expect(append([1], 5)).toEqual([1, 5]);
    expect(remove([1, 2, 3], 2)).toEqual([1, 3]);
  });
});

describe("queue.json", () => {
  test("round trip; a broken file reads as empty, non-positive numbers are dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-queue-"));
    try {
      expect(readOrder(dir)).toEqual([]);
      writeOrder(dir, [3, 1]);
      expect(readOrder(dir)).toEqual([3, 1]);
      mkdirSync(join(dir, "hollr-sandcastle"), { recursive: true });
      writeFileSync(join(dir, "hollr-sandcastle", "queue.json"), '{"version":1,"order":[4,-1,"x",2.5,6]}');
      expect(readOrder(dir)).toEqual([4, 6]);
      writeFileSync(join(dir, "hollr-sandcastle", "queue.json"), "{kaputt");
      expect(readOrder(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
