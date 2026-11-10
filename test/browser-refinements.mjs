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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output =
    process.env.BT_OUTPUT ||
    path.resolve(root, "../../.tmp/bt-031-refinements");
const selected =
  process.argv.find((arg) => arg.startsWith("--case="))?.slice(7) || "all";
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
    version: manifest.version,
    method: "Isolated Playwright; simulated local provider",
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
  for (const mode of ["selection", "hover", "input"])
    await options.locator("#quick-" + mode).check();
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8787/interactions.html");
  await page.bringToFront();
  await page.waitForFunction(() =>
    document.querySelector("[data-bt-interactions]"),
  );
  const panel = page.locator("[data-bt-interactions]");
  const setModel = async (model) => {
    await options.bringToFront();
    await options.locator("#model").fill(model);
    await options.locator("#save").click();
    await options.getByText("配置已保存", { exact: false }).waitFor();
    await page.bringToFront();
  };
  const dispatched = async (count) => {
    const deadline = Date.now() + 5000;
    while (mock.requests.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      mock.requests.length >= count,
      "controlled provider request reached the server",
    );
  };
  const select = (selector) =>
    page.evaluate((selector) => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(selector));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, selector);
  if (selected === "all" || selected === "hover") {
    await page.locator("h1").click();
    const rect = await page.locator("#hover-one").boundingBox(),
      before = mock.requests.length;
    await page.mouse.move(rect.x + 10, rect.y + 8);
    await page.keyboard.down("Alt");
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(rect.x + 12 + (i % 3), rect.y + 8);
      await page.waitForTimeout(65);
    }
    await page.keyboard.up("Alt");
    assert.equal(
      mock.requests.length - before,
      1,
      "jitter inside one paragraph must not restart dwell indefinitely",
    );
    await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
    report.checks.push(
      "same-paragraph pointer movement preserves the initial hover deadline and sends once",
    );
    await page.keyboard.press("Escape");
    await page.locator("#hover-one").evaluate((element) => {
      element.textContent =
        "A new paragraph while a sensitive field is focused.";
    });
    await page.locator("#private").focus();
    await page.mouse.move(rect.x + 10, rect.y + 8);
    await page.keyboard.down("Alt");
    await page.waitForTimeout(650);
    await page.keyboard.up("Alt");
    assert.equal(
      mock.requests.length - before,
      1,
      "focusing an excluded field must suppress all hover gestures",
    );
    report.checks.push(
      "a focused sensitive input also suppresses paragraph hover",
    );
  }
  if (selected === "all" || selected === "input") {
    await setModel("mock-delay");
    await page.locator("#message").fill("Old field pending");
    const before = mock.requests.length;
    await page.keyboard.press("Alt+t");
    await dispatched(before + 1);
    await page.locator("#short").fill("");
    const hasNewEntry = await panel
      .getByRole("button", { name: "翻译输入内容", exact: true })
      .count();
    await page.keyboard.press("Alt+t");
    await page.waitForTimeout(2700);
    assert.deepEqual(
      {
        hasNewEntry,
        oldResult: await panel
          .locator("[data-result]")
          .filter({ hasText: "MOCK" })
          .count(),
        text: await page.locator("#short").inputValue(),
      },
      { hasNewEntry: 1, oldResult: 0, text: "" },
    );
    assert.equal(mock.requests.length, before + 1);
    report.checks.push(
      "switching input host offers its own entry and an empty target cannot be replaced by an old slow preview",
    );
    await page.keyboard.press("Escape");
  }
  if (selected === "all" || selected === "selection") {
    await setModel("mock-delay");
    await page.locator("h1").click();
    await select("#selection-text");
    const before = mock.requests.length;
    await panel
      .getByRole("button", { name: "翻译选中内容", exact: true })
      .click();
    await dispatched(before + 1);
    const count = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: "http://127.0.0.1:8787/interactions.html",
      });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const controller = await globalThis.__btNextInteractionsLoading,
            original = controller.send.bind(controller);
          let cancelled = 0;
          controller.send = (type, data) => {
            if (type === "INTERACTION_CANCEL") cancelled++;
            return original(type, data);
          };
          const other = document.createElement("p");
          other.textContent =
            document.getElementById("selection-text").textContent;
          document.body.append(other);
          const range = document.createRange();
          range.selectNodeContents(other);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          controller.send = original;
          return cancelled;
        },
      });
      return result.result;
    });
    assert.equal(
      count,
      1,
      "a different nonempty range cancels immediately instead of waiting for the toolbar debounce",
    );
    report.checks.push(
      "a new Range with identical wording invalidates the prior request immediately",
    );
    await page.keyboard.press("Escape");
    await setModel("mock-latency");
    await select("#selection-text");
    await panel
      .getByRole("button", { name: "翻译选中内容", exact: true })
      .click();
    await panel.locator("[data-result]").filter({ hasText: "MOCK" }).waitFor();
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.waitForTimeout(200);
    assert.match(
      await panel.locator("[data-result]").innerText(),
      /independent reading/,
    );
    report.checks.push(
      "manual card snapshot remains readable when browser selection collapses",
    );
  }
  if (selected === "all" || selected === "cache") {
    await options.bringToFront();
    await options.locator("#cache").check();
    await options.locator("#model").fill("mock-latency");
    await options.locator("#save").click();
    await options.getByText("配置已保存", { exact: false }).waitFor();
    await page.bringToFront();
    await worker.evaluate(() => {
      globalThis.__originalCacheTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === "bt-next-cache" && args[1] === "readwrite")
          throw Error("controlled cache write failure");
        return globalThis.__originalCacheTransaction.apply(this, args);
      };
    });
    try {
      await page.locator("#selection-text").evaluate((element) => {
        element.textContent = "A distinct source for a visible cache failure.";
      });
      await select("#selection-text");
      const before = mock.requests.length;
      await panel
        .getByRole("button", { name: "翻译选中内容", exact: true })
        .click();
      await panel
        .locator("[data-result]")
        .filter({ hasText: "MOCK" })
        .waitFor();
      assert.match(await panel.getByRole("status").innerText(), /缓存.*异常/);
      assert.equal(mock.requests.length, before + 1);
      await panel
        .getByRole("dialog")
        .screenshot({ path: path.join(output, "cache-warning.png") });
      report.checks.push(
        "persistent cache failure remains visible while a real simulated-provider translation is displayed",
      );
    } finally {
      await worker.evaluate(() => {
        IDBDatabase.prototype.transaction =
          globalThis.__originalCacheTransaction;
      });
    }
  }
  assert.equal(report.errors.length, 0);
  report.requests = mock.requests.length;
  report.browser = context.browser().version();
  await fs.writeFile(
    path.join(output, "refinement-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => mock.server.close(resolve));
}
