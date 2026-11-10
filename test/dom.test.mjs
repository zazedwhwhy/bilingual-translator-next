import { test } from "node:test";
import assert from "node:assert/strict";
import { splitText } from "../src/shared/core.js";
test("long text splitting never truncates surrogate pairs or whitespace", () => {
  for (const text of [
    "a".repeat(5000),
    "🙂".repeat(2401),
    "日本語です。".repeat(900),
    "a\n b ".repeat(2000),
  ]) {
    const pieces = splitText(text);
    assert.equal(pieces.join(""), text);
    assert.ok(pieces.every((x) => [...x].length <= 1200));
  }
});
test("content extractor and renderer are importable without browser side effects", async () => {
  const e = await import("../src/content/extractor.js");
  const r = await import("../src/content/renderer.js");
  assert.equal(typeof e.Extractor, "function");
  assert.equal(typeof r.Renderer, "function");
});
