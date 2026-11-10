import { test } from "node:test";
import assert from "node:assert/strict";
const selection = await import("../src/subtitles/selection.js").catch(
  () => null,
);
const video = {
  id: "main",
  tracks: [
    { id: "zh", language: "zh-CN", label: "Chinese" },
    { id: "en-auto", language: "en", automatic: true },
    { id: "ja", language: "ja" },
    { id: "en-human", language: "en", automatic: false },
  ],
};
test("quick caption selection chooses existing foreign text and prefers a human English track", () => {
  assert.ok(selection);
  assert.equal(
    selection.preferredCaption(video, { source: "auto", target: "zh-CN" }).id,
    "en-human",
  );
  assert.equal(
    selection.preferredCaption(video, { source: "ja", target: "zh-CN" }).id,
    "ja",
  );
  assert.equal(
    selection.preferredCaption(
      { ...video, tracks: [video.tracks[1]] },
      { source: "auto", target: "zh-CN" },
    ).id,
    "en-auto",
  );
});
test("quick path never sends target-only or unknown-language text for redundant translation", () => {
  assert.ok(selection);
  assert.equal(
    selection.preferredCaption(
      {
        id: "main",
        tracks: [
          { id: "zh", language: "zh-TW" },
          { id: "unknown", label: "Subtitles" },
        ],
      },
      { target: "zh-CN" },
    ),
    null,
  );
});
