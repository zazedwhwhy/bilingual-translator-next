import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAsrConfig,
  publicAsrConfig,
  transcribeBlob,
} from "../src/media/asr.js";
const config = {
  endpoint: "https://api.openai.com/v1/audio/transcriptions",
  model: "whisper-1",
  secret: "private-key",
  language: "auto",
  responseFormat: "verbose_json",
};
test("ASR config accepts explicit HTTPS or loopback endpoint and hides secret", () => {
  const c = validateAsrConfig(config);
  assert.equal(c.origin, "https://api.openai.com/*");
  assert.equal(publicAsrConfig(c).secret, undefined);
  assert.equal(publicAsrConfig(c).hasKey, true);
  for (const endpoint of [
    "http://evil.test/transcribe",
    "https://user:pass@api.example.test/asr",
    "https://example.test/asr?key=x",
    "file:///tmp/audio",
  ])
    assert.throws(() => validateAsrConfig({ ...config, endpoint }));
  assert.equal(
    validateAsrConfig({ ...config, endpoint: "http://127.0.0.1:8787/api/asr" })
      .origin,
    "http://127.0.0.1/*",
  );
});
test("ASR posts real binary multipart without placing credential in body", async () => {
  let request;
  const blob = new Blob(["RIFF real test audio"], { type: "audio/wav" });
  const cues = await transcribeBlob(
    blob,
    { ...config, name: "audio.wav" },
    {
      fetcher: async (url, options) => {
        request = { url, options };
        assert.equal(options.body.get("file").size, blob.size);
        assert.equal(options.body.get("model"), "whisper-1");
        assert.equal(options.body.get("timestamp_granularities[]"), "segment");
        assert.equal(options.headers.Authorization, "Bearer private-key");
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        return new Response(
          JSON.stringify({ segments: [{ start: 0, end: 1, text: "Hello" }] }),
        );
      },
    },
  );
  assert.equal(cues[0].end, 1);
  assert.equal(request.options.body.has("secret"), false);
});
test("ASR refuses text-only result and oversized audio rather than inventing time", async () => {
  await assert.rejects(
    transcribeBlob(new Blob(["audio"]), config, {
      fetcher: async () => new Response('{"text":"without timing"}'),
    }),
    { code: "ASR_NO_TIMESTAMPS" },
  );
  await assert.rejects(
    transcribeBlob(new Blob([new Uint8Array(25 * 1024 * 1024)]), config),
    { code: "AUDIO_TOO_LARGE" },
  );
});
test("ASR accepts timestamped VTT and propagates cancellation with no retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const task = transcribeBlob(new Blob(["audio"]), config, {
    signal: controller.signal,
    fetcher: async (url, options) => {
      calls++;
      return new Promise((resolve, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason),
        ),
      );
    },
  });
  controller.abort();
  await assert.rejects(task, { code: "CANCELLED" });
  assert.equal(calls, 1);
  const cues = await transcribeBlob(
    new Blob(["audio"]),
    { ...config, responseFormat: "vtt" },
    {
      fetcher: async () =>
        new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTimed text\n"),
    },
  );
  assert.equal(cues[0].start, 1);
});

test("ASR preserves programming failures and classifies a missing response body as invalid", async () => {
  const bug = new RangeError("adapter bug");
  await assert.rejects(
    transcribeBlob(new Blob(["audio"]), config, {
      fetcher: async () => {
        throw bug;
      },
    }),
    (error) => error === bug,
  );
  await assert.rejects(
    transcribeBlob(new Blob(["audio"]), config, {
      fetcher: async () => ({ ok: true, body: null }),
    }),
    { code: "ASR_RESPONSE_INVALID" },
  );
});
