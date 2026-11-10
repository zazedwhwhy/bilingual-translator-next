import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    process.env.BT_OUTPUT || path.join(os.tmpdir(), "bt-document-verification");
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
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/ui/workbench.html`);
  page.on("console", (m) => {
    if (m.type() === "error")
      console.log("page-console", m.text().slice(0, 300));
  });
  const badEpub = await page.evaluate(async () => {
    const { zipSync, strToU8 } = await import("../vendor/zip.js");
    const { openXMLDocument } = await import("../documents/formats.js");
    const bytes = zipSync({
      "META-INF/container.xml": strToU8(
        '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>',
      ),
      "OPS/content.opf": strToU8(
        '<package><manifest><item id="chapter" href="one.xhtml"/></manifest><spine><itemref idref="missing"/></spine><p>Metadata must not become book content</p></package>',
      ),
      "OPS/one.xhtml": strToU8("<html><body><p>Real chapter</p></body></html>"),
    });
    try {
      openXMLDocument("broken.epub", bytes);
      return null;
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  });
  assert.equal(
    badEpub?.code,
    "FILE_INVALID",
    "unknown EPUB spine resources must fail explicitly",
  );
  report.checks.push(
    "broken EPUB spine fails without translating package metadata",
  );
  for (const file of [
    "sample.txt",
    "sample.md",
    "sample.html",
    "sample.epub",
    "sample.docx",
    "sample.pptx",
    "sample.xlsx",
    "inline.xlsx",
    "sample.pdf",
    "scanned.pdf",
  ]) {
    console.log("checking", file);
    await page
      .locator("#document-file")
      .setInputFiles(path.join(root, "test/fixtures/documents", file));
    await page.waitForFunction(
      () =>
        ["ready", "error"].includes(
          document.querySelector("#document-status").dataset.phase,
        ),
      null,
      { timeout: 90000 },
    );
    assert.equal(
      await page.locator("#document-status").getAttribute("data-phase"),
      "ready",
      await page.locator("#document-status").textContent(),
    );
    assert.ok((await page.locator(".document-source").count()) > 0, file);
    if (file === "sample.pptx")
      assert.equal(
        (await page.locator(".document-source").first().textContent()).trim(),
        "Slide one",
      );
    if (file === "sample.epub")
      assert.ok(
        (await page.locator(".document-source").first().textContent()).includes(
          "Second chapter",
        ),
      );
    if (file === "scanned.pdf")
      assert.ok(
        /SCANNED|DOCUMENT/i.test(
          await page.locator("#document-content").textContent(),
        ),
      );
    await page.locator("#document-translate").click();
    await page.waitForFunction(
      () =>
        ["complete", "error", "interrupted"].includes(
          document.querySelector("#document-status").dataset.phase,
        ),
      null,
      { timeout: 90000 },
    );
    assert.equal(
      await page.locator("#document-status").getAttribute("data-phase"),
      "complete",
      await page.locator("#document-status").textContent(),
    );
    const download = page.waitForEvent("download");
    await page.locator("#document-export").click();
    const result = await download;
    await result.saveAs(path.join(output, result.suggestedFilename()));
    if (file.endsWith(".pdf")) {
      const bytes = [
        ...(await fs.readFile(path.join(output, result.suggestedFilename()))),
      ];
      const content = await page.evaluate(async (data) => {
        const lib = await import(chrome.runtime.getURL("src/vendor/pdf.mjs"));
        lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
          "src/vendor/pdf.worker.mjs",
        );
        const task = lib.getDocument({
          data: new Uint8Array(data),
          isEvalSupported: false,
        });
        const doc = await task.promise;
        const text = await (await doc.getPage(2)).getTextContent();
        const result = {
          pages: doc.numPages,
          text: text.items.map((t) => t.str || "").join(" "),
        };
        await task.destroy();
        return result;
      }, bytes);
      assert.ok(content.pages >= 2);
      assert.ok(
        content.text.includes("MOCK") && content.text.includes("译文"),
        content.text,
      );
    }
    report.checks.push(file + " import → mock translate → native export");
    if (file === "scanned.pdf")
      await page.screenshot({
        path: path.join(output, "scanned-bilingual.png"),
      });
  }
  assert.equal(report.errors.length, 0);
  report.browser = context.browser().version();
  report.requests = mock.requests.length;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(
    path.join(output, "documents-results.json"),
    JSON.stringify(report, null, 2),
  );
  await context?.close();
  mock.server.closeAllConnections();
  await new Promise((r) => mock.server.close(r));
}
