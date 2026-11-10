import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSubtitles,
  exportSubtitles,
  validateTimedSegments,
  mergeTranscripts,
} from "../src/subtitles/cues.js";
test("SRT retains IDs, multilingual multiline text and timing without HTML execution", () => {
  const cues = parseSubtitles(
    "42\n00:00:01,250 --> 00:00:03,000\n<b>Hello</b>\nWorld\n\n43\n00:00:04,000 --> 00:00:05,100\nNext",
    "srt",
  );
  assert.equal(cues[0].id, "42");
  assert.equal(cues[0].start, 1.25);
  assert.equal(cues[0].text, "Hello\nWorld");
  cues[0].translation = "你好\n世界";
  const output = exportSubtitles(cues, "srt");
  assert.ok(output.startsWith("42\n"));
  assert.ok(output.includes("00:00:01,250 --> 00:00:03,000"));
  assert.ok(output.includes("Hello\nWorld\n你好\n世界"));
});
test("WebVTT settings and cue identifiers roundtrip; invalid time is an error", () => {
  const source =
    "WEBVTT\n\nNOTE ignored note\nmetadata\n\nchapter-one\n00:01.000 --> 00:02.500 align:start position:20%\nText\n";
  const cues = parseSubtitles(source, "vtt");
  assert.equal(cues[0].settings, "align:start position:20%");
  assert.equal(cues[0].id, "chapter-one");
  assert.ok(
    exportSubtitles(cues, "vtt").includes(
      "chapter-one\n00:00:01.000 --> 00:00:02.500 align:start position:20%",
    ),
  );
  assert.throws(
    () => parseSubtitles("1\n00:00:03,000 --> 00:00:01,000\nBad", "srt"),
    { code: "SUBTITLE_INVALID" },
  );
});
test("ASR text-only output must not be assigned fabricated timestamps", () => {
  assert.throws(() => validateTimedSegments({ text: "Only text" }), {
    code: "ASR_NO_TIMESTAMPS",
  });
  assert.throws(
    () =>
      validateTimedSegments({ segments: [{ start: 0, end: NaN, text: "x" }] }),
    { code: "SUBTITLE_INVALID" },
  );
  assert.equal(
    validateTimedSegments({
      segments: [{ start: 1, end: 2, text: "Hello" }],
    })[0].start,
    1,
  );
});
test("independent audio chunks retain real offsets, gaps and deterministic IDs", () => {
  const chunks = [
    {
      id: "a",
      offset: 0,
      cues: [{ id: "0", start: 1, end: 2, text: "First" }],
    },
    {
      id: "b",
      offset: 30.4,
      cues: [{ id: "0", start: 0.1, end: 1, text: "Second" }],
    },
  ];
  const all = mergeTranscripts(chunks);
  assert.equal(all[1].start, 30.5);
  assert.equal(all[1].id, "b:0");
  assert.equal(all[1].end, 31.4);
});
