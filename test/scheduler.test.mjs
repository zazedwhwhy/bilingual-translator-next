import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/content/scheduler.js";

test("retry acknowledges queue resume without awaiting all network work", async () => {
  let finish;
  const x = create(async (type) => {
    if (type === "PREPARE")
      return {
        ids: ["a"],
        cached: [],
        batches: [{ batchId: "b", items: [{ id: "a", text: "hello" }] }],
      };
    if (type === "BATCH") return new Promise((r) => (finish = r));
    return {};
  });
  x.s.scan();
  x.s.visible.add("p");
  x.s.rows.get("p").status = "error";
  const result = await Promise.race([
    x.s.retry().then(() => true),
    new Promise((r) => setTimeout(() => r(false), 30)),
  ]);
  x.s.stop();
  finish?.({ translations: [{ id: "a", text: "late" }] });
  assert.equal(result, true);
});
test("changed revision during in-flight request is scheduled after stale result", async () => {
  let finish,
    calls = 0;
  const x = create(async (type) => {
    if (type === "PREPARE")
      return {
        ids: ["a"],
        cached: [],
        batches: [{ batchId: "b", items: [{ id: "a", text: "hello" }] }],
      };
    if (type === "BATCH") {
      if (++calls === 1) return new Promise((r) => (finish = r));
      return { translations: [{ id: "a", text: "new revision" }] };
    }
    return {};
  });
  x.s.scan();
  x.s.visible.add("p");
  const pending = x.s.pump();
  await new Promise((r) => setTimeout(r, 0));
  x.record.text = "changed";
  x.record.revision = 1;
  x.s.scan();
  finish({ translations: [{ id: "a", text: "stale" }] });
  await pending;
  assert.equal(x.shown.length, 1);
  assert.equal(x.shown[0][1], "new revision");
});

test("fatal batch error wins over earlier sibling cancellation and disables retry", async () => {
  const x = create(async (type, data) => {
    if (type === "PREPARE")
      return {
        budget: { segmentsUsed: 0 },
        ids: ["a", "b"],
        cached: [],
        batches: [
          { batchId: "first", items: [{ id: "a", text: "a" }] },
          { batchId: "second", items: [{ id: "b", text: "b" }] },
        ],
      };
    if (type === "BATCH")
      throw Object.assign(Error(), {
        code: data.batchId === "first" ? "CANCELLED" : "AUTH_FAILED",
        budget: { segmentsUsed: 2 },
      });
    return {};
  });
  x.s.scan();
  x.s.visible.add("p");
  await x.s.pump();
  assert.equal(x.s.state().error.code, "AUTH_FAILED");
  assert.equal(x.s.state().fatal, true);
  assert.equal(x.s.state().budget.segmentsUsed, 2);
});
test("failed dispatch updates displayed authoritative budget", async () => {
  const x = create(async (type) => {
    if (type === "PREPARE")
      return {
        budget: { segmentsUsed: 0 },
        ids: ["a"],
        cached: [],
        batches: [{ batchId: "b", items: [{ id: "a", text: "hello" }] }],
      };
    if (type === "BATCH")
      throw Object.assign(Error(), {
        code: "TIMEOUT",
        budget: { segmentsUsed: 1, codePointsUsed: 5 },
      });
    return {};
  });
  x.s.scan();
  x.s.visible.add("p");
  await x.s.pump();
  assert.equal(x.s.state().budget.segmentsUsed, 1);
});
function create(send) {
  const shown = [];
  const record = {
    id: "p",
    revision: 0,
    text: "hello",
    element: { isConnected: true },
  };
  const extractor = {
    scan: () => [record],
    current: (r) => r.text === record.text,
  };
  const renderer = {
    show: (...x) => shown.push(x),
    remove: () => {},
    restore: () => (shown.length = 0),
  };
  return {
    s: new Session({
      job: { id: "job", target: "zh-CN" },
      extractor,
      renderer,
      send,
    }),
    shown,
    record,
  };
}
test("partial fragments never render a partial paragraph", async () => {
  const x = create(async (type) =>
    type === "PREPARE"
      ? {
          ids: ["a", "b"],
          cached: [{ id: "a", text: "first" }],
          batches: [{ batchId: "b", items: [{ id: "b", text: "two" }] }],
        }
      : Promise.reject(Object.assign(Error(), { code: "RESPONSE_FORMAT" })),
  );
  x.s.scan();
  x.s.visible.add("p");
  await x.s.pump();
  assert.equal(x.shown.filter((x) => !x[3]).length, 0);
  assert.equal(x.s.state().phase, "error");
});
test("cancelled and stale responses never insert translation", async () => {
  let finish;
  const x = create(async (type) =>
    type === "PREPARE"
      ? {
          ids: ["a"],
          cached: [],
          batches: [{ batchId: "b", items: [{ id: "a", text: "hello" }] }],
        }
      : type === "BATCH"
        ? new Promise((r) => (finish = r))
        : {},
  );
  x.s.scan();
  x.s.visible.add("p");
  const p = x.s.pump();
  await new Promise((r) => setTimeout(r, 0));
  x.s.stop();
  finish({ translations: [{ id: "a", text: "late" }] });
  await p;
  assert.equal(x.shown.length, 0);
  assert.equal(x.s.state().phase, "cancelled");
});
