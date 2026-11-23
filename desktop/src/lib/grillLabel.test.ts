import { describe, expect, test } from "bun:test";
import { grillTicket } from "./grillLabel";

describe("grillTicket", () => {
  test("interactive and auto with key and number", () => {
    expect(grillTicket("Grill TENDR-1071 · #3551")).toBe("TENDR-1071:3551");
    expect(grillTicket("Auto-Grill TENDR-1071 · #3551")).toBe("TENDR-1071:3551");
  });
  test("number only", () => {
    expect(grillTicket("Grill #12")).toBe(":12");
    expect(grillTicket("Auto-Grill #12")).toBe(":12");
  });
  test("key only", () => expect(grillTicket("Grill TENDR-1")).toBe("TENDR-1:"));
  test("other labels", () => {
    for (const l of ["Grillen #3", "grill #3", "Grill tendr-1 · #3", "Sandcastle haccp", "", undefined])
      expect(grillTicket(l)).toBeUndefined();
  });
});
