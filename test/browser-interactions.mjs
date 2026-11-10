import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output =
  process.env.BT_OUTPUT || path.resolve(root, "../../.tmp/bt-030-interactions");
const bundle = path.join(output, "extension");
await fs.mkdir(bundle, { recursive: true });
await fs.cp(path.join(root, "src"), path.join(bundle, "src"), {
  recursive: true,
});
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json")),
);
manifest.host_permissions = ["http://*/*", "https://*/*"];
await fs.writeFile(
  path.join(bundle, "manifest.json"),
  JSON.stringify(manifest),
);
const registry = path.join(bundle, "src/providers/registry.js");
await fs.writeFile(
  registry,
  (await fs.readFile(registry, "utf8"))
    .replace(
      "https://api.openai.com/v1/chat/completions",
      "http://127.0.0.1:8787/api/openai",
    )
    .replaceAll("https://api.openai.com/*", "http://127.0.0.1/*"),
);
const mock = await startMock(),
  report = {
    method:
      "Isolated Playwright; local simulated provider; no daily Chrome or Computer Use",
    checks: [],
    errors: [],
  };
let context;
try {
  context = await chromium.launchPersistentContext(
    path.join(output, "owned-profile-" + Date.now()),
    {
      headless: true,
      channel: "chromium",
      args: [
        `--load-extension=${bundle}`,
        `--disable-extensions-except=${bundle}`,
      ],
      viewport: { width: 1280, height: 1000 },
    },
  );
  context.on("page", (page) =>
    page.on("pageerror", (error) => report.errors.push(error.message)),
  );
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/ui/options.html`);
  await options.locator("#provider").selectOption("openai");
  await options.locator("#model").fill("mock-latency");
  await options.locator("#key").fill("test-key");
  await options.locator("#save").click();
  await options.getByText("配置已保存", { exact: false }).waitFor();
  assert.equal(
    await options.locator("#quick-selection").count(),
    1,
    "selection settings must be implemented",
  );
  await options.locator("#quick-selection").check();
  await options.locator("#quick-hover").check();
  await options.locator("#quick-input").check();
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8787/interactions.html");
  await page.bringToFront();
  await page.waitForFunction(() =>
    document.querySelector("[data-bt-interactions]"),
  );
  const panel = page.locator("[data-bt-interactions]");
  const readyRace = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      url: "http://127.0.0.1:8787/interactions.html",
    });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const controller = await globalThis.__btNextInteractionsLoading,
          original = controller.send.bind(controller);
        let reject;
        controller.send = async () =>
          new Promise((_, fail) => {
            reject = fail;
          });
        const old = controller.refresh();
        controller.send = original;
        await controller.refresh();
        reject(Error("old initialization failed"));
        await old;
        return controller.preferences.selection;
      },
    });
    return result.result;
  });
  assert.equal(
    readyRace,
    true,
    "late initialization failure must not disable a newer ready controller",
  );
  report.checks.push(
    "late initialization failure cannot clear newer preferences",
  );
  await page.locator("#hover-two").hover();
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.waitForTimeout(700);
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  assert.equal(
    mock.requests.length,
    0,
    "an extra modifier must not trigger a paid Alt hover",
  );
  report.checks.push(
    "Ctrl+Alt combination does not accidentally trigger hover translation",
  );
  const selectText = async (selector) => {
    await page.evaluate((selector) => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(selector));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, selector);
  };
  await selectText("#selection-text");
  await panel
    .getByRole("button", { name: "翻译选中内容", exact: true })
    .waitFor();
  assert.equal(
    mock.requests.length,
    0,
    "selection alone must not call the provider",
  );
  await panel
    .getByRole("button", { name: "翻译选中内容", exact: true })
    .click();
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  assert.equal(mock.requests.length, 1);
  report.checks.push(
    "selection requires a click, translates just the selected text",
  );
  await page.screenshot({ path: path.join(output, "selection-preview.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator("#hover-one").hover();
  await page.waitForTimeout(650);
  assert.equal(mock.requests.length, 1);
  await page.keyboard.down("Alt");
  await page.waitForTimeout(120);
  await page.locator("#hover-two").hover();
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  await page.keyboard.up("Alt");
  assert.equal(mock.requests.length, 2);
  assert.equal(
    JSON.parse(mock.requests[1].body.messages.at(-1).content).items[0].text,
    "The second paragraph belongs to another request.",
  );
  report.checks.push(
    "ordinary hover makes zero requests; Alt dwell rechecks the final paragraph",
  );
  await page.keyboard.press("Escape");
  await page.locator("#message").focus();
  await page.keyboard.press("Alt+t");
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  assert.equal(
    await page.locator("#message").inputValue(),
    "你好，欢迎阅读。",
    "input preview must not write before confirmation",
  );
  assert.equal(
    JSON.parse(mock.requests.at(-1).body.messages.at(-1).content).target,
    "en",
  );
  await panel
    .getByRole("button", { name: "替换输入内容", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("message").value.startsWith("MOCK"),
  );
  assert.match(await page.locator("#message").inputValue(), /^MOCK/);
  assert.equal(
    await page.evaluate(() => controlled),
    await page.locator("#message").inputValue(),
  );
  assert.equal(await page.evaluate(() => submits), 0);
  await panel.getByRole("button", { name: "撤销替换", exact: true }).click();
  assert.equal(await page.locator("#message").inputValue(), "你好，欢迎阅读。");
  report.checks.push(
    "input translates to independent target, previews, confirms, notifies controlled field and safely undoes without submitting",
  );
  await page.screenshot({ path: path.join(output, "input-preview.png") });
  await page.keyboard.press("Escape");
  const before = mock.requests.length;
  await page.locator("#private").focus();
  await page.keyboard.press("Alt+t");
  await page.locator("#payment").focus();
  await page.keyboard.press("Alt+t");
  await page.waitForTimeout(650);
  assert.equal(mock.requests.length, before);
  report.checks.push("password and payment fields cannot dispatch");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#message").focus();
  await page.keyboard.press("Alt+t");
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  const bounds = await panel.getByRole("dialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({ path: path.join(output, "input-narrow.png") });
  report.checks.push(
    "narrow viewport keeps translation panel inside the screen",
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator("#short").focus();
  await page
    .locator("#short")
    .evaluate((element) => element.setSelectionRange(6, 11));
  await page.keyboard.press("Alt+t");
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  await panel
    .getByRole("button", { name: "替换输入内容", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("short").value.includes("MOCK"),
  );
  assert.equal(
    await page.locator("#short").inputValue(),
    "Hello MOCK 译文：world!",
  );
  await panel.getByRole("button", { name: "撤销替换", exact: true }).click();
  assert.equal(await page.locator("#short").inputValue(), "Hello world!");
  report.checks.push(
    "selected input substring preserves surrounding text and undo restores it",
  );
  await page.keyboard.press("Escape");
  await page.locator("#rich").focus();
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.keyboard.press("Alt+t");
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  await panel
    .getByRole("button", { name: "替换输入内容", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("rich").innerText.startsWith("MOCK"),
  );
  await panel.getByRole("button", { name: "撤销替换", exact: true }).click();
  assert.equal(await page.locator("#rich").innerHTML(), "Hello <b>world</b>");
  report.checks.push(
    "simple rich text preview/replacement restores original formatting on undo",
  );
  await page.keyboard.press("Escape");
  const compositionBefore = mock.requests.length;
  await page.locator("#message").focus();
  await page.locator("#message").dispatchEvent("compositionstart");
  await page.keyboard.press("Alt+t");
  await page.waitForTimeout(500);
  assert.equal(mock.requests.length, compositionBefore);
  await page.locator("#message").dispatchEvent("compositionend");
  report.checks.push(
    "simulated IME composition blocks a real keyboard shortcut request",
  );
  const setModel = async (model) => {
    await options.bringToFront();
    await options.locator("#model").fill(model);
    await options.locator("#save").click();
    await options.getByText("配置已保存", { exact: false }).waitFor();
    await page.bringToFront();
  };
  const dispatched = async (count) => {
    const deadline = Date.now() + 6000;
    while (mock.requests.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(
      mock.requests.length >= count,
      "provider received the controlled slow request",
    );
  };
  await setModel("mock-delay");
  await page.locator("#message").fill("Slow original input");
  const slowBefore = mock.requests.length;
  await page.keyboard.press("Alt+t");
  await dispatched(slowBefore + 1);
  await page.locator("#message").fill("My newer input");
  await page.waitForTimeout(2700);
  assert.equal(await page.locator("#message").inputValue(), "My newer input");
  assert.equal(
    await panel
      .getByRole("button", { name: "替换输入内容", exact: true })
      .count(),
    0,
  );
  assert.equal(mock.requests.length, slowBefore + 1);
  report.checks.push(
    "editing during an actually dispatched slow request cancels stale output with no automatic retry",
  );
  await page.keyboard.press("Escape");
  await page.locator("#message").focus();
  const disableBefore = mock.requests.length;
  await page.keyboard.press("Alt+t");
  await dispatched(disableBefore + 1);
  await options.bringToFront();
  await options.locator("#quick-input").uncheck();
  await options.locator("#quick-input").isEnabled();
  await page.bringToFront();
  await page.waitForTimeout(2700);
  await page.locator("#message").focus();
  await page.keyboard.press("Alt+t");
  await page.waitForTimeout(300);
  assert.equal(mock.requests.length, disableBefore + 1);
  assert.equal(await page.locator("#message").inputValue(), "My newer input");
  assert.equal(
    await panel
      .getByRole("button", { name: "替换输入内容", exact: true })
      .count(),
    0,
  );
  report.checks.push(
    "disabling input during a request cancels the old preview and prevents new input calls",
  );
  await page.locator("h1").click();
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator("#hover-one").hover();
  const hoverBefore = mock.requests.length;
  await page.keyboard.down("Alt");
  await dispatched(hoverBefore + 1);
  await page.locator("#private").hover();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(2700);
  assert.equal(
    await panel.locator("[data-result]").count(),
    0,
    "moving to an excluded hover target cancels the old result",
  );
  report.checks.push(
    "moving from a pending hover into an excluded field prevents a stale hover result",
  );
  await setModel("mock-latency");
  await selectText("#selection-text");
  await panel
    .getByRole("button", { name: "翻译选中内容", exact: true })
    .click();
  await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      url: "http://127.0.0.1:8787/interactions.html",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: undefined,
        });
      },
    });
  });
  await panel.getByRole("button", { name: "复制译文", exact: true }).click();
  await page.waitForTimeout(100);
  assert.match(await panel.getByRole("status").innerText(), /无法自动复制/);
  report.checks.push(
    "unavailable clipboard shows manual-copy guidance without a runtime exception",
  );
  await page.keyboard.press("Escape");
  const beforeInit = mock.requests.length;
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      url: "http://127.0.0.1:8787/interactions.html",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const controller = await globalThis.__btNextInteractionsLoading;
        globalThis.__btOriginalInteractionSend =
          controller.send.bind(controller);
        controller.send = async () => {
          throw Object.assign(Error("连接暂时不可用，请重新连接。"), {
            code: "INTERRUPTED",
          });
        };
        await controller.refresh();
        controller.send = globalThis.__btOriginalInteractionSend;
      },
    });
  });
  assert.match(await panel.getByRole("status").innerText(), /连接|启动|初始化/);
  await panel.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await panel.getByRole("dialog").count(), 0);
  assert.equal(mock.requests.length, beforeInit);
  report.checks.push(
    "initialization failure is visible and an explicit reconnect restores entries without a provider request",
  );
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      url: "http://127.0.0.1:8787/interactions.html",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        globalThis.__btNextInteractionsLoading = Promise.reject(
          Error("controlled module load failure"),
        );
        globalThis.__btNextInteractionsLoading.catch(() => {});
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content/interaction-bootstrap.js"],
    });
  });
  assert.match(
    await page.locator("[data-bt-interaction-error]").innerText(),
    /未启动/,
  );
  report.checks.push("module startup failure has a visible page notice");
  assert.equal(report.errors.length, 0);
  report.requests = mock.requests.length;
  report.browser = context.browser().version();
  await fs.writeFile(
    path.join(output, "interaction-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => mock.server.close(resolve));
}
