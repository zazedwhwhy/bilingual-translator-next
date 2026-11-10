import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeCaptions, captionURL } from "../src/subtitles/youtube.js";
test("YouTube JSON3 uses returned timestamps, never fills a missing duration", () => {
  assert.equal(
    parseYouTubeCaptions({
      events: [
        {
          tStartMs: 1250,
          dDurationMs: 1000,
          segs: [{ utf8: "Hello " }, { utf8: "world" }],
        },
      ],
    })[0].end,
    2.25,
  );
  assert.throws(
    () =>
      parseYouTubeCaptions({
        events: [{ tStartMs: 0, segs: [{ utf8: "missing duration" }] }],
      }),
    { code: "SUBTITLE_INVALID" },
  );
});
test("caption fetch cannot become a cross-origin arbitrary proxy", () => {
  assert.ok(
    captionURL(
      "https://www.youtube.com/api/timedtext?v=test",
      "https://www.youtube.com/watch?v=test",
    ).includes("fmt=json3"),
  );
  for (const url of [
    "https://evil.test/api/timedtext",
    "https://www.youtube.com/redirect",
    "https://www.youtube.com.evil.test/api/timedtext",
  ])
    assert.throws(() =>
      captionURL(url, "https://www.youtube.com/watch?v=test"),
    );
});

import * as youtube from "../src/subtitles/youtube.js";
test("YouTube retains late English/Chinese tracks and binds choices to the live video", () => {
  assert.equal(
    typeof youtube.youtubeTrackChoices,
    "function",
    "platform track choices must preserve all languages",
  );
  const rows = Array.from({ length: 45 }, (_, i) => ({
    languageCode: "x" + i,
    vssId: "x" + i,
    baseUrl: "https://www.youtube.com/api/timedtext?v=old",
    name: { simpleText: "Language " + i },
  }));
  rows.push(
    {
      languageCode: "en",
      vssId: ".en",
      baseUrl: "https://www.youtube.com/api/timedtext?v=current",
      name: { simpleText: "English" },
    },
    {
      languageCode: "zh-CN",
      vssId: ".zh-CN",
      baseUrl: "https://www.youtube.com/api/timedtext?v=current",
      name: { simpleText: "中文" },
    },
  );
  for (const row of rows)
    row.baseUrl = row.baseUrl.replace("v=old", "v=current");
  const tracks = youtube.youtubeTrackChoices(
    {
      current: { videoId: "current", tracks: rows },
      initial: { videoId: "old", tracks: [] },
    },
    "https://www.youtube.com/watch?v=current",
    "auto",
  );
  assert.equal(tracks.length, 47);
  assert.equal(tracks[0].language, "en");
  assert.ok(tracks.some((t) => t.language === "zh-CN"));
  assert.ok(tracks.every((t) => t.id.includes("current")));
  assert.throws(
    () =>
      youtube.youtubeTrackChoices(
        { current: { videoId: "old", tracks: rows } },
        "https://www.youtube.com/watch?v=current",
        "auto",
      ),
    { code: "VIDEO_CHANGED" },
  );
});
test("YouTube caption URL cannot fetch another video after SPA navigation", () => {
  assert.throws(
    () =>
      captionURL(
        "https://www.youtube.com/api/timedtext?v=old",
        "https://www.youtube.com/watch?v=current",
      ),
    { code: "SUBTITLE_INVALID" },
  );
});
