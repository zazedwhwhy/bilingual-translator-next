import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output =
    process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-asr-verification");
await fs.mkdir(output, { recursive: true });
const bundle = path.join(output, "extension");
await fs.cp(path.join(root, "src"), path.join(bundle, "src"), {
  recursive: true,
});
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json")),
);
manifest.host_permissions = ["http://127.0.0.1/*"];
await fs.writeFile(
  path.join(bundle, "manifest.json"),
  JSON.stringify(manifest),
);
const reg = path.join(bundle, "src/providers/registry.js");
await fs.writeFile(
  reg,
  (await fs.readFile(reg, "utf8"))
    .replace(
      "https://api.openai.com/v1/chat/completions",
      "http://127.0.0.1:8787/api/openai",
    )
    .replaceAll("https://api.openai.com/*", "http://127.0.0.1/*"),
);
const wav = Buffer.alloc(44 + 16000 * 2 * 2);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let n = 0; n < 32000; n++)
  wav.writeInt16LE(
    Math.round(Math.sin((n / 16000) * 440 * Math.PI * 2) * 5000),
    44 + n * 2,
  );
const mock = await startMock();
let context;
const report = { checks: [], errors: [] };
try {
  context = await chromium.launchPersistentContext(
    path.join(output, "profile-" + Date.now()),
    {
      headless: true,
      channel: "chromium",
      args: [
        `--disable-extensions-except=${bundle}`,
        `--load-extension=${bundle}`,
      ],
      viewport: { width: 1440, height: 1000 },
    },
  );
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(e.message)),
  );
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("mock-ok");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  await options.locator("#asr-endpoint").fill("http://127.0.0.1:8787/api/asr");
  await options.locator("#asr-model").fill("mock-timed");
  await options.locator("#asr-key").fill("asr-test-key");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  assert.equal(mock.requests.filter((r) => r.provider === "asr").length, 0);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/ui/workbench.html`);
  const concurrent = await page.evaluate(async () => {
    const rpc = async (type, data = {}) => {
      const r = await chrome.runtime.sendMessage({
        channel: "BT_BG",
        type,
        ...data,
      });
      if (!r.ok) throw Error(r.error.message);
      return r.data;
    };
    const { id } = await rpc("ASR_CREATE");
    const { addAudio } = await import("../media/store.js");
    await Promise.all([
      addAudio(id, new Blob(["first"]), { name: "a.wav" }),
      addAudio(id, new Blob(["second"]), { name: "b.wav" }),
    ]);
    const status = await rpc("ASR_STATUS", { sessionId: id });
    await rpc("ASR_DELETE", { sessionId: id });
    return status.chunks.length;
  });
  assert.equal(
    concurrent,
    2,
    "concurrent audio append must preserve both chunks",
  );
  report.checks.push("concurrent chunk appends preserve both records");
  await page
    .locator("#asr-file")
    .setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: wav });
  await page.waitForFunction(
    () => document.querySelector("#asr-status").dataset.phase === "ready",
  );
  await page.locator("#asr-start").click();
  await page.waitForFunction(
    () =>
      ["complete", "error"].includes(
        document.querySelector("#asr-status").dataset.phase,
      ),
    null,
    { timeout: 45000 },
  );
  assert.equal(
    await page.locator("#asr-status").getAttribute("data-phase"),
    "complete",
    await page.locator("#asr-status").textContent(),
  );
  const request = mock.requests.find((r) => r.provider === "asr");
  assert.ok(request.hasWave && request.bytes > wav.length);
  assert.equal(request.authorization, "Bearer asr-test-key");
  assert.equal(request.credentialInBody, false);
  assert.ok(
    (await page.locator("#subtitle-list").textContent()).includes("MOCK"),
  );
  report.checks.push(
    "audio file → real multipart POST in offscreen → timed segments → batch translation",
  );
  const dl = page.waitForEvent("download");
  await page.locator("#subtitle-srt").click();
  await (await dl).saveAs(path.join(output, "ai-双语.srt"));
  const srt = await fs.readFile(path.join(output, "ai-双语.srt"), "utf8");
  assert.ok(srt.includes("00:00:01,000 --> 00:00:01,900"));
  assert.ok(srt.includes("Recognized second line") && srt.includes("MOCK"));
  report.checks.push(
    "AI SRT export preserves actual returned segment boundaries",
  );
  await options.locator("#asr-model").fill("mock-no-time");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await page.locator("#asr-start").click();
  await page.waitForFunction(
    () => document.querySelector("#asr-status").dataset.phase === "error",
  );
  assert.ok(
    (await page.locator("#asr-status").textContent()).includes(
      "ASR_NO_TIMESTAMPS",
    ),
  );
  assert.equal(await page.locator("#subtitle-srt").isDisabled(), true);
  assert.equal(await page.locator("#subtitle-list").textContent(), "");
  report.checks.push(
    "text-only ASR result fails without fabricated timing or old captions",
  );
  await options.locator("#asr-model").fill("mock-delay");
  await options.locator("#asr-save").click();
  await options.getByText("语音配置已保存", { exact: false }).waitFor();
  await page.locator("#asr-start").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#asr-status").dataset.phase === "transcribing",
  );
  const restart = await page.evaluate(async () => {
    const rpc = async (type, data = {}) =>
      chrome.runtime.sendMessage({ channel: "BT_BG", type, ...data });
    const {
      data: { id },
    } = await rpc("ASR_CREATE");
    const { addAudio } = await import("../media/store.js");
    await addAudio(id, new Blob(["local restart fixture"]), {
      name: "restart.wav",
    });
    await rpc("ASR_RUN", { sessionId: id });
    for (let i = 0; i < 20; i++) {
      const r = await rpc("ASR_STATUS", { sessionId: id });
      if (r.data.phase === "transcribing") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await chrome.offscreen.closeDocument();
    const resumed = await rpc("ASR_RUN", { sessionId: id });
    await rpc("ASR_DELETE", { sessionId: id });
    return resumed;
  });
  assert.equal(
    restart.ok,
    false,
    "a dead offscreen task must not be accepted as running",
  );
  assert.equal(restart.error.code, "INTERRUPTED");
  report.checks.push(
    "offscreen loss rejects stale accepted state instead of silently idling",
  );
  await page.locator("#asr-stop").click();
  await page.waitForFunction(
    () => document.querySelector("#asr-status").dataset.phase === "cancelled",
  );
  await new Promise((r) => setTimeout(r, 2800));
  assert.equal(
    await page.locator("#asr-status").getAttribute("data-phase"),
    "cancelled",
  );
  assert.equal(await page.locator("#subtitle-srt").isDisabled(), true);
  report.checks.push("stop aborts ASR and rejects late results");
  await page.locator("#asr-clear").click();
  await page.waitForFunction(
    () => document.querySelector("#asr-status").dataset.phase === "idle",
  );
  const rows = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("bt-next-media", 1);
      r.onsuccess = () => resolve(r.result);
    });
    return new Promise((resolve) => {
      const r = db.transaction("records").objectStore("records").getAll();
      r.onsuccess = () => resolve(r.result.length);
    });
  });
  assert.equal(rows, 0);
  report.checks.push(
    "clear removes audio Blob and transcript session from local storage",
  );
  assert.equal(report.errors.length, 0);
  report.browser = context.browser().version();
  await page.screenshot({ path: path.join(output, "asr-workbench.png") });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(output, "asr-results.json"),
    JSON.stringify(report, null, 2),
  );
  await context?.close();
  mock.server.closeAllConnections();
  await new Promise((r) => mock.server.close(r));
}
