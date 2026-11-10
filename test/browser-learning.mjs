import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  {
    chromium,
  } = require("C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = process.cwd(),
  output = path.resolve(process.env.BT_OUTPUT || "../../.tmp/bt-040-learning"),
  bundle = path.join(output, "extension");
await fs.mkdir(bundle, { recursive: true });
await fs.cp(path.join(root, "src"), path.join(bundle, "src"), {
  recursive: true,
});
const manifest = JSON.parse(await fs.readFile("manifest.json", "utf8"));
manifest.host_permissions = ["http://*/*", "https://*/*"];
await fs.writeFile(
  path.join(bundle, "manifest.json"),
  JSON.stringify(manifest),
);
const requests = [],
  checks = [],
  errors = [];
let malformed = false;
const source =
  "We should break the ice before the interview. The result was encouraging.";
const server = http.createServer(async (req, res) => {
  if (req.url === "/api") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw),
      system = b.messages[0].content,
      input = JSON.parse(b.messages.at(-1).content);
    requests.push({ system, input });
    let result;
    if (system.includes("English reading tutor")) {
      if (malformed)
        result = {
          items: [
            {
              text: "fabricated nonexistent phrase",
              translation: "bad",
              reason: "bad",
            },
          ],
        };
      else if (system.includes('"questions"'))
        result = {
          questions: [
            {
              kind: "comprehension",
              question: "What happens before the interview?",
              options: ["Break the ice", "Sleep", "Leave", "Run"],
              answer: 0,
              explanation: "They intend to ease the atmosphere.",
              evidence: "break the ice before the interview",
            },
            {
              kind: "vocabulary",
              question: "What does encouraging mean?",
              options: ["Discouraging", "Positive", "Unclear", "Late"],
              answer: 1,
              explanation: "It gives confidence.",
              evidence: "The result was encouraging.",
            },
          ],
        };
      else if (system.includes('"explanation"'))
        result = {
          explanation:
            "Here break the ice means making people comfortable, not breaking frozen water.",
          evidence: "break the ice",
        };
      else
        result = {
          items: [
            {
              text: "encouraging",
              translation: "令人鼓舞的",
              reason: "Useful for describing a positive result",
            },
          ],
        };
    } else
      result = {
        translations: input.items.map((x) => ({ id: x.id, text: "模拟译文" })),
      };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
          },
        ],
      }),
    );
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html lang="en"><title>Learning fixture</title><body><article><h1>Reading practice</h1><p id="body">We should <span id="phrase">break the ice</span> before the interview. The result was encouraging.</p><p hidden>HIDDEN_SENTINEL</p><p contenteditable>EDITABLE_SENTINEL</p><form><p>FORM_SENTINEL</p></form></article></body></html>`,
  );
});
await new Promise((resolve, reject) =>
  server.listen(0, "127.0.0.1", resolve).on("error", reject),
);
const port = server.address().port,
  base = `http://127.0.0.1:${port}`;
const registry = path.join(bundle, "src/providers/registry.js");
await fs.writeFile(
  registry,
  (await fs.readFile(registry, "utf8"))
    .replace("https://api.openai.com/v1/chat/completions", base + "/api")
    .replace("https://api.openai.com/*", "http://127.0.0.1/*"),
);
let context, page, manage;
try {
  context = await chromium.launchPersistentContext(
    path.join(output, "profile-" + Date.now()),
    {
      headless: true,
      channel: "chromium",
      args: [
        `--load-extension=${bundle}`,
        `--disable-extensions-except=${bundle}`,
      ],
      viewport: { width: 1360, height: 1000 },
    },
  );
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("local-fixture");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  await options.locator("#quick-selection").check();
  manage = await context.newPage();
  await manage.goto(`chrome-extension://${id}/src/ui/learning.html`);
  await manage.locator("#enabled").check();
  await manage.locator("#save").click();
  await manage.getByText("学习设置已保存。", { exact: false }).waitFor();
  page = await context.newPage();
  await page.goto(base + "/article");
  await page.bringToFront();
  const quick = page.locator("[data-bt-interactions]"),
    learn = page.locator('[data-bt-next="learning"]');
  await quick.waitFor({ state: "attached" });
  await learn.getByText("学英语", { exact: true }).waitFor();
  const select = () =>
    page.locator("#phrase").evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
  const read = async () => {
    const r = await manage.evaluate(() =>
      chrome.runtime.sendMessage({ channel: "BT_BG", type: "LEARN_GET" }),
    );
    assert.equal(r.ok, true);
    return r.data;
  };
  await select();
  await quick.getByText("翻译选中内容", { exact: true }).click();
  await quick
    .locator("[data-result]")
    .filter({ hasText: "模拟译文" })
    .waitFor();
  let state = await read();
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].text, "break the ice");
  assert.equal(state.records[0].learning, true);
  assert.ok(state.records[0].context.includes("before the interview"));
  checks.push(
    "real selection translation automatically records expression and local context",
  );
  assert.ok(
    !JSON.stringify(requests[0].input).includes("before the interview"),
    "translation request excludes surrounding context",
  );
  await quick.getByText("关闭", { exact: true }).click();
  // Starting actual page translation automatically initiates an independent recommendation.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  await page.bringToFront();
  const tab = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    return tabs.find((t) => t.url.endsWith("/article")).id;
  });
  const started = await popup.evaluate(
    (tabId) =>
      chrome.runtime.sendMessage({ channel: "BT_BG", type: "START", tabId }),
    tab,
  );
  assert.equal(started.ok, true);
  await learn.getByText("加入学习", { exact: true }).waitFor();
  state = await read();
  assert.equal(state.records.length, 1);
  checks.push(
    "actual page translation asynchronously recommends without automatic enrollment",
  );
  await learn.getByText("加入学习", { exact: true }).click();
  await learn.getByText("encouraging · 已加入", { exact: true }).waitFor();
  assert.equal((await read()).records.length, 2);
  checks.push("explicit recommendation selection adds to learning queue");
  await select();
  await learn.getByText("解释选中表达", { exact: true }).click();
  await learn.getByText(/not breaking frozen water/).waitFor();
  checks.push("selected expression explained with nearby context");
  await learn.getByText("文章练习", { exact: true }).click();
  await learn.getByText("Break the ice", { exact: true }).click();
  await learn.getByText("Positive", { exact: true }).click();
  await learn.getByText(/本次 2\/2/).waitFor();
  checks.push(
    "comprehension and vocabulary questions grade only after answering",
  );
  await learn.getByText("本页重遇", { exact: true }).click();
  await learn.getByText("揭晓", { exact: true }).first().click();
  await learn.getByText("记得", { exact: true }).first().click();
  assert.equal(
    (await read()).records.find((r) => r.text === "break the ice").step,
    1,
  );
  checks.push("encounter reveal and remember persist schedule");
  malformed = true;
  await learn.getByText("推荐可学表达", { exact: true }).click();
  await learn.getByText(/学习结果格式或原文证据无效/).waitFor();
  assert.equal((await read()).records.length, 2);
  malformed = false;
  checks.push(
    "invalid model evidence gives visible failure without creating records",
  );
  const before = requests.length;
  await learn
    .getByText("推荐可学表达", { exact: true })
    .evaluate((b) => b.click());
  await page.waitForTimeout(150);
  assert.equal(requests.length, before);
  checks.push("synthetic webpage clicks cannot trigger paid AI requests");
  await page.screenshot({ path: path.join(output, "learning-page.png") });
  await manage.bringToFront();
  await manage.reload();
  await manage.getByText("学习库已就绪。", { exact: true }).waitFor();
  await manage.screenshot({
    path: path.join(output, "learning-library.png"),
    fullPage: true,
  });
  const downloadPromise = manage.waitForEvent("download");
  await manage.locator("#export").click();
  const download = await downloadPromise;
  const exported = path.join(output, "learning-export.json");
  await download.saveAs(exported);
  const exportedData = JSON.parse(await fs.readFile(exported, "utf8"));
  assert.equal(exportedData.records.length, 2);
  await manage.locator("#import").setInputFiles(exported);
  await manage.getByText(/已合并导入/).waitFor();
  assert.equal((await read()).records.length, 2);
  checks.push("actual export download and import preserve existing entries");
  await manage.locator("#enabled").uncheck();
  await manage.locator("#save").click();
  await manage.getByText("学习设置已保存。", { exact: false }).waitFor();
  await page.bringToFront();
  await learn.waitFor({ state: "hidden" });
  checks.push("disabling learning removes the page interface");
  assert.ok(
    requests
      .filter((r) => r.system.includes("English reading tutor"))
      .every((r) => !JSON.stringify(r.input).includes("SENTINEL")),
  );
  assert.deepEqual(errors, []);
  checks.push("hidden and editable fields excluded; no page errors");
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  await fs.writeFile(path.join(output, "failure.txt"), error.stack);
  throw error;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(
    path.join(output, "learning-results.json"),
    JSON.stringify(
      {
        version: manifest.version,
        method:
          "isolated Playwright and local simulated AI; not daily Chrome or live provider",
        checks,
        errors,
        requests: requests.length,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify(
    { checks, errors, requests: requests.length, output },
    null,
    2,
  ),
);
