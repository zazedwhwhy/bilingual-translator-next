import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBatch,
  parseTranslations,
  splitText,
  Budget,
  phase,
} from "../src/shared/core.js";
test("strict IDs are reordered; missing, duplicate, extra and blank translations fail", () => {
  assert.deepEqual(
    parseTranslations(
      '{"translations":[{"id":"b","text":"乙"},{"id":"a","text":"甲"}]}',
      ["a", "b"],
    ).map((x) => x.text),
    ["甲", "乙"],
  );
  for (const v of [
    [],
    [{ id: "a", text: "甲" }],
    [
      { id: "a", text: "甲" },
      { id: "a", text: "乙" },
    ],
    [
      { id: "a", text: " " },
      { id: "b", text: "乙" },
    ],
    [
      { id: "x", text: "甲" },
      { id: "b", text: "乙" },
    ],
  ])
    assert.throws(
      () => parseTranslations(JSON.stringify({ translations: v }), ["a", "b"]),
      /格式/,
    );
  assert.throws(() => parseTranslations('Here is {"translations":[]}', []));
});
test("bounded messages cannot smuggle URL, model or headers", () => {
  const b = { jobId: "j", batchId: "b", items: [{ id: "a", text: "hello" }] };
  assert.equal(validateBatch(b).items.length, 1);
  for (const extra of [
    { url: "https://evil.test" },
    { model: "evil" },
    { headers: {} },
  ])
    assert.throws(() => validateBatch({ ...b, ...extra }));
  assert.throws(() =>
    validateBatch({
      ...b,
      items: Array.from({ length: 9 }, (_, i) => ({
        id: String(i),
        text: "a",
      })),
    }),
  );
  assert.throws(() =>
    validateBatch({ ...b, items: [{ id: "a", text: "a".repeat(2401) }] }),
  );
});
test("split preserves every code point and whitespace", () => {
  const s = "Hello world. 🙂 日文。\n".repeat(150);
  const p = splitText(s);
  assert.equal(p.join(""), s);
  assert.ok(p.every((x) => [...x].length <= 1200));
});
test("budget reserves whole paragraphs and failed dispatch remains consumed", () => {
  const b = new Budget();
  assert.equal(b.reserve("x", Array(50).fill("a".repeat(1200))), true);
  b.dispatch("x");
  assert.equal(b.reserve("y", ["x"]), false);
  b.nextRound();
  assert.equal(b.reserve("y", ["x"]), true);
  b.release("y");
  assert.equal(b.totalChars, 60000);
  assert.throws(() => b.reserve("z", ["x".repeat(60001)]));
});
test("state prioritizes cancellation, interruptions and partial errors", () => {
  assert.equal(phase({ cancelled: true, interrupted: true }), "cancelled");
  assert.equal(
    phase({ errors: 1, translated: 2, offscreen: 3, budgetBlocked: true }),
    "partial_error",
  );
  assert.equal(phase({ offscreen: 3 }), "waiting_visible");
});
