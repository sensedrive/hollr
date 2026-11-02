import { describe, expect, test } from "bun:test";
import { formatCode, isCompleteCode, isPastedCode, isTailscaleAddress } from "./pairingCode";

describe("formatCode", () => {
  test("groups and uppercases while typing", () => {
    expect(formatCode("k7q2 m9xa-3pxd w8rt")).toBe("K7Q2-M9XA-3PXD-W8RT");
    expect(formatCode("3pld")).toBe("3P1D");
    expect(formatCode("k7q2m")).toBe("K7Q2-M");
    expect(formatCode("")).toBe("");
  });
  test("maps look-alikes and drops the rest", () => {
    expect(formatCode("oil u!")).toBe("011");
  });
  test("stops at 16 characters", () => {
    expect(formatCode("K7Q2M9XA3PXDW8RT4444")).toBe("K7Q2-M9XA-3PXD-W8RT");
    expect(isCompleteCode("K7Q2-M9XA-3PLD-W8R")).toBe(false);
    expect(isCompleteCode("k7q2m9xa3pldw8rt")).toBe(true);
  });
  test("pasted text counts only if it is exactly a code", () => {
    expect(isPastedCode(" k7q2-m9xa-3pld-w8rt\n")).toBe(true);
    expect(isPastedCode("Der Code ist K7Q2-M9XA-3PLD-W8RT")).toBe(false);
    expect(isPastedCode("hollr://pair?c=eyJ2IjoxLCJhIjpbIjE")).toBe(false);
  });
});

test("isTailscaleAddress", () => {
  expect(isTailscaleAddress("100.64.1.2")).toBe(true);
  expect(isTailscaleAddress("100.127.255.255")).toBe(true);
  expect(isTailscaleAddress("100.128.0.1")).toBe(false);
  expect(isTailscaleAddress("192.168.1.2")).toBe(false);
});
