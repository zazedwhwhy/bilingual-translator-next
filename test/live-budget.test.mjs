import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveBudget } from "./support/live-budget.mjs";
const body = {
  model: "deepseek-flash",
  max_tokens: 4096,
  thinking: { type: "disabled" },
  stream: false,
  messages: [
    { role: "system", content: "Translate" },
    { role: "user", content: "Hello" },
  ],
};
test("live test reserves full context cost before a request and keeps unknown failures charged", () => {
  const budget = new LiveBudget();
  assert.ok(LiveBudget.worstRmb < 4.5);
  const ticket = budget.admit(body, 200);
  assert.equal(budget.settle(ticket, null), false);
  assert.throws(() => budget.admit(body, 200), /LIVE_BUDGET_EXHAUSTED/);
  assert.ok(budget.snapshot().reservedRmb < 5);
});
test("live test allows at most two validated calls and forbids output/model/input expansion", () => {
  const b = new LiveBudget();
  for (const change of [
    { model: "deepseek-v4-pro" },
    { max_tokens: 8192 },
    { thinking: { type: "enabled" } },
  ])
    assert.throws(() => b.admit({ ...body, ...change }, 200));
  assert.throws(() => b.admit(body, 8001));
  for (let i = 0; i < 2; i++) {
    const t = b.admit(body, 200);
    assert.equal(
      b.settle(t, {
        prompt_tokens: 300,
        completion_tokens: 100,
        total_tokens: 400,
      }),
      true,
    );
  }
  assert.throws(() => b.admit(body, 200), /LIVE_BUDGET_EXHAUSTED/);
  assert.ok(b.snapshot().spentUpperRmb < 0.01);
});
