import test from "node:test";
import assert from "node:assert/strict";
import { LearningStore } from "../src/learning/store.js";
const setup = () => {
  let data = {};
  return new LearningStore({
    get: async () => structuredClone(data),
    set: async (x) => {
      data = structuredClone(x);
    },
  });
};
test("explicitly adding an archived recommendation reactivates it; querying alone does not", async () => {
  const s = setup();
  await s.configure({ enabled: true });
  const row = await s.record({ text: "break the ice", translation: "meaning" });
  await s.update(row.id, "archive");
  assert.equal(
    (await s.record({ text: row.text, translation: "meaning" })).learning,
    false,
  );
  assert.equal(
    (await s.record({ text: row.text, translation: "meaning", learning: true }))
      .learning,
    true,
  );
});
test("active short queries join review; paragraphs stay reading records; repeat queries preserve schedule", async () => {
  const s = setup();
  await s.configure({ enabled: true });
  const a = await s.record({
    text: "break the ice",
    translation: "打破僵局",
    context: "We need to break the ice.",
    url: "https://example.com/a?secret=x",
  });
  assert.equal(a.learning, true);
  assert.equal(a.url, "https://example.com/a");
  await s.review(a.id, "remember", 1000);
  const b = await s.record({ text: "break the ice", translation: "破冰" });
  assert.equal(b.step, 1);
  const c = await s.record({
    text: "This is a complete sentence.",
    translation: "这是一个完整的句子。",
  });
  assert.equal(c.learning, false);
});
