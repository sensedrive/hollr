import { describe, expect, test } from "bun:test";
import { codeKeys, compareVersions, isVersionTag, releasesByKey } from "../src/releases";
import type { Release } from "../src/types";

const rel = (tag: string, keys: string[], at = "2026-11-13T10:00:00.000Z"): Release => ({ tag, oid: `c-${tag}`, base: null, at, keys });

describe("releases from version tags", () => {
  test("version tags: X.Y.Z with or without v, no pre-releases; ordered by number, not text", () => {
    expect(["v1.0.0", "2.1.0", "v10.2.33"].every(isVersionTag)).toBe(true);
    expect(["v2.0.0-rc.1", "stage-177", "prototyp-shop-editor-2026-10-27", "v1.2"].some(isVersionTag)).toBe(false);
    expect(["v1.10.0", "v1.2.1", "v1.9.0", "v1.2.0", "v2.0.0"].sort(compareVersions)).toEqual(["v1.2.0", "v1.2.1", "v1.9.0", "v1.10.0", "v2.0.0"]);
  });

  test("codeKeys: docs commits, merges and reverts name no shipped work; keys in any case, gitmoji or not", () => {
    const keys = codeKeys([
      { subject: "📝 docs: TENDR-636 Spec und ADRs zum adaptiven Lasttest-System", merge: false },
      { subject: "📄 docs(tendr-956): notiz-layout nicht im rechnungsblock", merge: false },
      { subject: "Merge pull request #1056 from leicht-luftig/feature/TENDR-636-lasttest-spec", merge: true },
      { subject: "✨ feat(shop): TENDR-822 choose the payment method before the review page", merge: false },
      { subject: "🐛 fix(tendr-957): rundung im beleg", merge: false },
      { subject: "📝 test(backoffice-app): TENDR-731 laufnummer im kommentar berichtigen", merge: false },
      { subject: 'Revert "✨ feat(shop): TENDR-901 gutscheine im checkout"', merge: false },
      { subject: "⏪️ revert(shop): TENDR-902 drop voucher step", merge: false },
      { subject: "🌱 TENDR-538: Dev-Seed für Einrichtungstyp-Registrierungskontexte (#720)", merge: false },
    ]);
    expect(keys.sort()).toEqual(["TENDR-538", "TENDR-731", "TENDR-822", "TENDR-957"]);
  });

  test("releasesByKey: first release by the time it was tagged (a late hotfix comes after), later ones listed", () => {
    const map = releasesByKey([
      rel("v1.10.0", ["T-1"], "2026-11-01T10:00:00.000Z"),
      rel("v1.2.3", ["T-2"], "2026-11-20T10:00:00.000Z"),
      rel("v1.9.0", ["T-1", "T-2"], "2026-10-01T10:00:00.000Z"),
    ]);
    expect(map.get("T-1")).toEqual({ version: "v1.9.0", at: "2026-10-01T10:00:00.000Z", later: [{ version: "v1.10.0", at: "2026-11-01T10:00:00.000Z" }] });
    expect(map.get("T-2")).toEqual({ version: "v1.9.0", at: "2026-10-01T10:00:00.000Z", later: [{ version: "v1.2.3", at: "2026-11-20T10:00:00.000Z" }] });
    expect(map.has("T-3")).toBe(false);
  });
});
