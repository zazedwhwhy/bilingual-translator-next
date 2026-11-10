import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, decodeResponse } from "../src/providers/registry.js";
import { requestJson } from "../src/background/transport.js";
test("DeepSeek translation explicitly caps output and disables optional thinking", () => {
  const spec = buildRequest([{ id: "a", text: "Hello" }], {
      provider: "deepseek",
      model: "deepseek-flash",
      secret: "test-key",
      source: "auto",
      target: "zh-CN",
    }),
    body = JSON.parse(spec.body);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.thinking, { type: "disabled" });
});
test("text transport preserves programming errors instead of reporting every failure as network", async () => {
  const bug = new RangeError("request adapter defect");
  await assert.rejects(
    requestJson(
      { url: "https://example.test" },
      {
        fetcher: async () => {
          throw bug;
        },
      },
    ),
    (error) => error === bug,
  );
  const network = new TypeError("Failed to fetch");
  await assert.rejects(
    requestJson(
      { url: "https://example.test" },
      {
        fetcher: async () => {
          throw network;
        },
      },
    ),
    (error) => error.code === "NETWORK_ERROR" && error.cause === network,
  );
});
const items = [{ id: "a", text: "Hello" }],
  base = {
    secret: "test-key",
    model: "chosen-model",
    source: "auto",
    target: "zh-CN",
  };
for (const provider of ["google", "openai", "deepseek", "claude"])
  test(
    provider + " sends only intended text and explicit authentication",
    () => {
      const r = buildRequest(items, { ...base, provider });
      const body = JSON.parse(r.body);
      assert.equal(r.method, "POST");
      assert.ok(!r.body.includes("test-key"));
      if (provider === "google") {
        assert.deepEqual(body.q, ["Hello"]);
        assert.equal(body.source, undefined);
        assert.equal(body.format, "text");
        assert.equal(new URL(r.url).searchParams.get("key"), "test-key");
      } else {
        assert.equal(body.model, "chosen-model");
        assert.equal(r.headers.Authorization, "Bearer test-key");
        assert.equal(body.stream, false);
      }
      if (provider === "claude") {
        assert.equal(r.headers["anthropic-version"], "2026-10-21");
        assert.equal(body.max_tokens, 4096);
      }
    },
  );
test("google maps order, decodes entities, and rejects incomplete response", () => {
  assert.equal(
    decodeResponse(
      {
        data: {
          translations: [{ translatedText: "&lt;script&gt; &amp; &#x1f642;" }],
        },
      },
      items,
      "google",
    )[0].text,
    "<script> & 🙂",
  );
  assert.throws(() =>
    decodeResponse({ data: { translations: [] } }, items, "google"),
  );
});

test("Google oversized translation must not bypass output bound", () => {
  assert.throws(
    () =>
      decodeResponse(
        { data: { translations: [{ translatedText: "x".repeat(65537) }] } },
        items,
        "google",
      ),
    { code: "RESPONSE_TOO_LARGE" },
  );
});
test("AI rejects truncation, refusals and unexpected tools", () => {
  for (const r of [
    { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
    {
      choices: [
        { finish_reason: "stop", message: { refusal: "no", content: "{}" } },
      ],
    },
  ])
    assert.throws(() => decodeResponse(r, items, "openai"));
  assert.throws(() =>
    decodeResponse({ stop_reason: "tool_use", content: [] }, items, "claude"),
  );
  assert.equal(
    decodeResponse(
      {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: '{"translations":[{"id":"a","text":"你好"}]}' },
        ],
      },
      items,
      "claude",
    )[0].text,
    "你好",
  );
});
for (const [status, code] of [
  [401, "AUTH_FAILED"],
  [403, "AUTH_FAILED"],
  [429, "RATE_LIMITED"],
  [500, "HTTP_ERROR"],
])
  test("HTTP " + status + " is classified without retry", async () => {
    let calls = 0;
    await assert.rejects(
      requestJson(
        { url: "https://api.openai.com/v1/chat/completions" },
        {
          fetcher: async () => {
            calls++;
            return new Response("{}", {
              status,
              headers: { "Retry-After": "2" },
            });
          },
        },
      ),
      { code },
    );
    assert.equal(calls, 1);
  });
test("bounded transport rejects oversized body, omits cookies and blocks redirects", async () => {
  let init;
  await assert.rejects(
    requestJson(
      { url: "https://api.openai.com/test" },
      {
        fetcher: async (u, o) => {
          init = o;
          return new Response("a".repeat(262145));
        },
      },
    ),
    { code: "RESPONSE_TOO_LARGE" },
  );
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
});
test("abort and timeout cancel real request signal", async () => {
  let observed;
  await assert.rejects(
    requestJson(
      { url: "https://api.openai.com/test" },
      {
        timeout: 10,
        fetcher: async (u, o) =>
          new Promise((r, j) => {
            observed = o.signal;
            o.signal.addEventListener("abort", () => j(o.signal.reason));
          }),
      },
    ),
    { code: "TIMEOUT" },
  );
  assert.equal(observed.aborted, true);
});
