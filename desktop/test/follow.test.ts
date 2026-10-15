import { describe, expect, test } from "bun:test";
import { applyLine, backoff } from "../src/lib/follow";
import type { Timeline } from "../src/lib/api";

const full = {
  t: "full",
  title: "Chat",
  items: [
    { k: "user", id: "u1", text: "los" },
    { k: "text", id: "t1", text: "Hallo" },
    { k: "text", id: "t2", text: "Welt" },
  ],
  todo: [{ name: "A", tasks: [] }],
  jobs: [],
  running: true,
  waiting: false,
  status: "working",
  etag: "e1",
};
const line = (o: unknown) => JSON.stringify(o);
const start = (): Timeline => {
  const a = applyLine(null, line(full));
  if (a.kind !== "timeline") throw new Error(a.kind);
  return a.timeline;
};

describe("applyLine", () => {
  test("full: the timeline without the message type", () => {
    const tl = start();
    expect("t" in tl).toBe(false); expect((tl as unknown as { t?: string }).t).toBeUndefined();
    expect(tl.items.length).toBe(3);
    expect(tl.etag).toBe("e1");
  });

  test("delta: new and changed items by order, items out of the window dropped, head replaced", () => {
    const a = applyLine(start(), line({
      t: "delta",
      head: { title: "Chat", jobs: [], running: false, waiting: false, status: "idle" },
      order: ["t1", "t2", "e1"],
      items: [
        { k: "text", id: "t2", text: "Welt!" },
        { k: "end", id: "e1", ms: 1200, status: "ok" },
      ],
      etag: "e2",
    }));
    expect(a.kind).toBe("timeline");
    if (a.kind !== "timeline") return;
    expect(a.timeline.items).toEqual([
      { k: "text", id: "t1", text: "Hallo" },
      { k: "text", id: "t2", text: "Welt!" },
      { k: "end", id: "e1", ms: 1200, status: "ok" },
    ]);
    expect(a.timeline.status).toBe("idle");
    expect(a.timeline.running).toBe(false);
    // gone from head = gone from the timeline
    expect(a.timeline.todo).toBeUndefined();
    expect(a.timeline.etag).toBe("e2");
  });

  test("delta with an unknown id: resync", () => {
    const a = applyLine(start(), line({ t: "delta", head: {}, order: ["u1", "x9"], items: [], etag: "e3" }));
    expect(a.kind).toBe("resync");
  });

  test("delta without a timeline: resync", () => {
    expect(applyLine(null, line({ t: "delta", head: {}, order: [], items: [] })).kind).toBe("resync");
  });

  test("ping, junk, errors, older server", () => {
    expect(applyLine(null, line({ t: "ping" })).kind).toBe("none");
    expect(applyLine(null, "{nope").kind).toBe("none");
    expect(applyLine(null, line({ t: "error", error: "not_found" }))).toEqual({ kind: "error", error: "not_found" });
    expect(applyLine(null, line({ error: "not_allowed" })).kind).toBe("unsupported");
  });

  test("backoff: 0, 2, 4, 8, then 15 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoff)).toEqual([0, 2000, 4000, 8000, 15000, 15000]);
  });
});
