import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.BT_PLAYWRIGHT ||
    "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output =
  process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-next-verification");
await fs.mkdir(output, { recursive: true });
const bundle = path.join(output, "mock-extension");
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
const registry = path.join(bundle, "src/providers/registry.js");
let code = await fs.readFile(registry, "utf8");
for (const [name, url] of Object.entries({
  google: "https://translation.googleapis.com/language/translate/v2",
  openai: "https://api.openai.com/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  claude: "https://api.anthropic.com/v1/messages",
}))
  code = code.replace(url, "http://127.0.0.1:8787/api/" + name);
code = code.replaceAll(
  /https:\/\/(translation.googleapis.com|api.openai.com|api.deepseek.com|api.anthropic.com)\/\*/g,
  "http://127.0.0.1/*",
);
await fs.writeFile(registry, code);
// A normal action popup is attached to the current page. Playwright opens it as
// a tab, so only the copied test bundle resolves the explicit local fixture tab.
const popupScript = path.join(bundle, "src/ui/popup.js");
await fs.writeFile(
  popupScript,
  (await fs.readFile(popupScript, "utf8")).replace(
    /tabId\s*=\s*tab\?\.id/,
    "tabId=(await chrome.tabs.query({url:'http://127.0.0.1:8787/*'}))[0]?.id",
  ),
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
      viewport: { width: 1280, height: 900 },
    },
  );
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(e.message)),
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("mock-ok");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  const article = await context.newPage();
  await article.goto("http://127.0.0.1:8787/static.html");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  await popup.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    await article
      .evaluate(() => 0)
      .then(() =>
        worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({
            url: "http://127.0.0.1:8787/*",
          });
          return tabs[0].id;
        }),
      ),
  );
  await popup.locator("#start").click();
  await article.locator("#first [data-bt-next]").waitFor();
  assert.equal(await article.locator("#nested [data-bt-next]").count(), 1);
  assert.equal(
    await article
      .locator(
        "nav [data-bt-next],[contenteditable=true] [data-bt-next],[hidden] [data-bt-next]",
      )
      .count(),
    0,
  );
  assert.equal(await article.locator("#below [data-bt-next]").count(), 0);
  assert.ok(
    mock.requests.every(
      (r) => !JSON.stringify(r.body).includes("Private editor"),
    ),
  );
  report.checks.push(
    "UI save → click start → background mock request → bilingual DOM",
  );
  await article.screenshot({ path: path.join(output, "translated.png") });
  await article.locator("#below").scrollIntoViewIfNeeded();
  await article.locator("#below [data-bt-next]").waitFor();
  report.checks.push("scroll visibility scheduling");
  await article.locator("#first").scrollIntoViewIfNeeded();
  await article.evaluate(() => {
    document.querySelector("#first").firstChild.textContent =
      "Changed source article.";
  });
  await article.waitForFunction(() =>
    document
      .querySelector("#first [data-bt-next]")
      ?.textContent.includes("Changed source"),
  );
  report.checks.push("source revision invalidates old translation");
  await popup.locator("#restore").click();
  await article.waitForFunction(
    () => !document.querySelector("[data-bt-next]"),
  );
  report.checks.push("restore preserves original content");
  for (const provider of ["google", "deepseek", "claude"]) {
    await options.locator("#provider").selectOption(provider);
    await options.locator("#key").fill("test-key");
    if (provider !== "google") await options.locator("#model").fill("mock-ok");
    await options.locator("#save").click();
    await options.getByText("配置已保存", { exact: false }).waitFor();
    await popup.locator("#start").click();
    await article.locator("#first [data-bt-next]").waitFor();
    await popup.locator("#restore").click();
    await article.waitForFunction(
      () => !document.querySelector("[data-bt-next]"),
    );
    report.checks.push(provider + " mock end to end");
  }
  await options.locator("#provider").selectOption("openai");
  await options.locator("#key").fill("test-key");
  await options.locator("#model").fill("mock-missing");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  await popup.locator("#start").click();
  await article.locator(".bt-next-error").first().waitFor();
  await article.screenshot({ path: path.join(output, "error.png") });
  assert.equal(
    await article.locator(".bt-next-result:not(.bt-next-error)").count(),
    0,
  );
  report.checks.push(
    "invalid batch shows explicit error with no success nodes",
  );
  for (const mode of [
    "401",
    "429",
    "500",
    "invalid",
    "truncated",
    "oversize",
  ]) {
    await popup.locator("#restore").click();
    await options.locator("#model").fill("mock-" + mode);
    await options.locator("#save").click();
    await options.getByText("配置已保存", { exact: false }).waitFor();
    const start = mock.requests.length;
    await popup.locator("#start").click();
    await article.locator(".bt-next-error").first().waitFor();
    await popup.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("失败"),
    );
    await new Promise((r) => setTimeout(r, 400));
    const sent = mock.requests.slice(start);
    assert.ok(sent.length > 0);
    const bodies = sent.map((x) => JSON.stringify(x.body));
    assert.equal(new Set(bodies).size, bodies.length);
    assert.equal(
      await article.locator(".bt-next-result:not(.bt-next-error)").count(),
      0,
    );
    if (mode === "401")
      assert.equal(await popup.locator("#retry").isDisabled(), true);
    assert.ok(
      await popup
        .waitForFunction(() =>
          /已请求 [1-9]/.test(document.querySelector("#status").textContent),
        )
        .then(() => true),
      await popup.locator("#status").textContent(),
    );
    report.checks.push(
      "mock " +
        mode +
        ": explicit error, counted dispatch, no automatic repeat",
    );
  }
  await popup.locator("#restore").click();
  await options.locator("#model").fill("mock-delay");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  const prior = mock.requests.length;
  await popup.locator("#start").click();
  await new Promise((r) => setTimeout(r, 300));
  await popup.locator("#stop").click();
  await new Promise((r) => setTimeout(r, 2700));
  assert.equal(await article.locator("[data-bt-next]").count(), 0);
  report.checks.push("stop prevents late DOM insertion");
  const isolation = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:8787/*" });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        let storage;
        try {
          storage = await chrome.storage.local.get("connection");
        } catch {
          storage = { denied: true };
        }
        const message = await chrome.runtime.sendMessage({
          channel: "BT_BG",
          type: "SAVE_CONFIG",
          config: { secret: "injected" },
        });
        return { storage, message };
      },
    });
    return result.result;
  });
  assert.ok(!JSON.stringify(isolation.storage).includes("test-key"));
  assert.equal(isolation.message.error.code, "INVALID_MESSAGE");
  assert.equal(
    await article.evaluate(async () =>
      JSON.stringify(await indexedDB.databases()).includes("bt-next-cache"),
    ),
    false,
  );
  report.checks.push(
    "content cannot read key, mutate config, or access extension cache",
  );
  await popup.locator("#start").click();
  await new Promise((r) => setTimeout(r, 300));
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find(
    (t) => t.type === "service_worker" && t.url === worker.url(),
  );
  assert.ok(target);
  await cdp.send("Target.closeTarget", { targetId: target.targetId });
  await popup.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("结果未知"),
  );
  await new Promise((r) => setTimeout(r, 2700));
  assert.equal(await article.locator("[data-bt-next]").count(), 0);
  report.checks.push(
    "worker termination interrupts job without automatic replay",
  );
  await options.screenshot({ path: path.join(output, "options.png") });
  await popup.screenshot({ path: path.join(output, "popup.png") });
  report.requestCount = mock.requests.length;
  report.browser = await context.browser().version();
  assert.equal(report.errors.length, 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(output, "browser-results.json"),
    JSON.stringify(report, null, 2),
  );
  await context?.close();
  await new Promise((r) => mock.server.close(r));
}
