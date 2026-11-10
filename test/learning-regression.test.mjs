import test from "node:test";
import assert from "node:assert/strict";
import { LearningStore } from "../src/learning/store.js";
import { learningResponse } from "../src/learning/ai.js";

function harness() {
  let value;
  return {
    store: new LearningStore({
      get: async () =>
        value ? { englishLearningV1: structuredClone(value) } : {},
      set: async (row) => {
        value = structuredClone(row.englishLearningV1);
      },
    }),
    snapshot: () => structuredClone(value),
  };
}
const source =
  "We should break the ice before the interview. The result was encouraging.";
const response = (data) => ({
  choices: [
    { finish_reason: "stop", message: { content: JSON.stringify(data) } },
  ],
});

test("closed learning mode does not record queries", async () => {
  const h = harness();
  assert.equal(
    await h.store.record({
      text: "break the ice",
      translation: "to break the ice",
    }),
    null,
  );
  assert.deepEqual((await h.store.read()).records, []);
});
test("parallel captures preserve every distinct entry", async () => {
  const h = harness();
  await h.store.configure({ enabled: true });
  await Promise.all(
    ["break the ice", "encouraging", "once in a blue moon"].map((text) =>
      h.store.record({ text, translation: "translation" }),
    ),
  );
  assert.equal((await h.store.read()).records.length, 3);
});
test("bad import leaves the existing library byte for byte intact", async () => {
  const h = harness();
  await h.store.configure({ enabled: true });
  await h.store.record({
    text: "break the ice",
    translation: "to break the ice",
  });
  const before = h.snapshot();
  assert.throws(() => h.store.import({ version: 1, records: [{ id: "bad" }] }));
  assert.deepEqual(h.snapshot(), before);
});
test("remember, forget and skip update only the requested schedule", async () => {
  const h = harness();
  await h.store.configure({ enabled: true });
  const item = await h.store.record({
    text: "break the ice",
    translation: "to break the ice",
  });
  const first = await h.store.review(item.id, "remember", 1_000_000);
  assert.equal(first.step, 1);
  assert.equal(first.due, 1_000_000 + 86400000);
  const skipped = await h.store.review(item.id, "skip", 2_000_000);
  assert.equal(skipped.due, first.due);
  const forgotten = await h.store.review(item.id, "forget", 3_000_000);
  assert.equal(forgotten.step, 0);
  assert.equal(forgotten.due, 3_000_000 + 86400000);
});
test("library can be cleared without disabling learner preferences", async () => {
  const h = harness();
  await h.store.configure({ enabled: true, level: "B2" });
  await h.store.record({
    text: "break the ice",
    translation: "to break the ice",
  });
  await h.store.clear();
  const state = await h.store.read();
  assert.equal(state.preferences.enabled, true);
  assert.equal(state.preferences.level, "B2");
  assert.deepEqual(state.records, []);
});
test("AI cannot recommend fabricated phrases outside the article", () =>
  assert.throws(
    () =>
      learningResponse(
        "recommend",
        response({
          items: [
            {
              text: "make a million dollars",
              translation: "earn money",
              reason: "useful",
            },
          ],
        }),
        "openai",
        source,
      ),
    { code: "LEARNING_RESPONSE" },
  ));
test("AI rejects fabricated evidence, malformed questions and forged answer indices", () => {
  assert.throws(
    () =>
      learningResponse(
        "explain",
        response({
          explanation: "Means success",
          evidence: "fabricated source quote",
        }),
        "openai",
        source,
      ),
    { code: "LEARNING_RESPONSE" },
  );
  assert.throws(
    () =>
      learningResponse(
        "exercise",
        response({
          questions: [
            {
              kind: "comprehension",
              question: "Q?",
              options: ["a", "b", "c", "d"],
              answer: 7,
              explanation: "e",
              evidence: "The result was encouraging.",
            },
            {
              kind: "vocabulary",
              question: "Q?",
              options: ["a", "b", "c", "d"],
              answer: 0,
              explanation: "e",
              evidence: "encouraging",
            },
          ],
        }),
        "openai",
        source,
      ),
    { code: "LEARNING_RESPONSE" },
  );
});
