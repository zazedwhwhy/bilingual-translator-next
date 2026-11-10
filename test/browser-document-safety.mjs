import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(base, "package.json"));
const {
  PDFDocument,
  PDFName,
  PDFString,
  PDFArray,
  PDFDict,
} = require("pdf-lib");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const {
  chromium,
} = require("C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const work = process.env.BT_OUTPUT || path.join(base, "../../.tmp/doc-audit");
await fs.mkdir(work, { recursive: true });
const fontPath = "C:/Windows/Fonts/msyh.ttc";
GlobalFonts.registerFromPath(fontPath, "Microsoft YaHei");
const canvas = createCanvas(1600, 360),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, 1600, 360);
ctx.fillStyle = "#111";
ctx.font = "bold 66px 'Microsoft YaHei'";
ctx.fillText("中文扫描页 OCR 验证", 60, 135);
ctx.fillText("第二行：文档识别成功", 60, 245);
const pdf = await PDFDocument.create();
const png = await pdf.embedPng(canvas.toBuffer("image/png"));
pdf.addPage([800, 180]).drawImage(png, { x: 0, y: 0, width: 800, height: 180 });
const bytes = [...(await pdf.save())];
await fs.writeFile(path.join(work, "chinese-scan.pdf"), new Uint8Array(bytes));
const activeSource = await PDFDocument.create();
const activePage = activeSource.addPage([595, 842]);
const jsAction = activeSource.context.obj({
  S: PDFName.of("JavaScript"),
  JS: PDFString.of('app.alert("PDF action probe")'),
});
const linkAnnot = activeSource.context.obj({
  Type: PDFName.of("Annot"),
  Subtype: PDFName.of("Link"),
  Rect: [0, 0, 120, 50],
  A: jsAction,
});
const linkRef = activeSource.context.register(linkAnnot);
activePage.node.set(PDFName.of("Annots"), activeSource.context.obj([linkRef]));
const activeBytes = [...(await activeSource.save())];
const profile = path.join(work, "profile");
const browserRoot = "C:/Users/wange/Documents/ChatGPT/rea/.tmp/bt-browsers";
process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: path.join(
      browserRoot,
      "chromium-1234/chrome-win64/chrome.exe",
    ),
    headless: true,
    args: [`--disable-extensions-except=${base}`, `--load-extension=${base}`],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/ui/options.html`);
  const ocr = await page.evaluate(async (payload) => {
    const api = await import(chrome.runtime.getURL("src/documents/pdf.js"));
    const model = await api.openPDF(
      "chinese-scan.pdf",
      new Uint8Array(payload),
      { ocr: true },
    );
    const result = { pages: model.pages, segments: model.segments };
    await model.dispose();
    return result;
  }, bytes);
  const translatedActiveBytes = await page.evaluate(async (payload) => {
    const api = await import(chrome.runtime.getURL("src/documents/pdf.js"));
    const result = await api.exportPDF(
      { bytes: new Uint8Array(payload), segments: [{ id: "probe", page: 1 }] },
      new Map([["probe", "译文"]]),
    );
    return [...result];
  }, activeBytes);
  const activeOut = await PDFDocument.load(
    new Uint8Array(translatedActiveBytes),
  );
  const annots = activeOut.getPage(0).node.get(PDFName.of("Annots"));
  let copiedAction = null;
  if (annots instanceof PDFArray) {
    const annotDict = activeOut.context.lookup(annots.get(0));
    const actionDict =
      annotDict instanceof PDFDict
        ? activeOut.context.lookup(annotDict.get(PDFName.of("A")))
        : null;
    copiedAction = actionDict?.get?.(PDFName.of("S"))?.toString() || null;
  }
  const cancellation = await page.evaluate(async (payload) => {
    const NativeWorker = window.Worker;
    window.__workerRecords = [];
    window.__abortOnWorker = true;
    const controller = new AbortController();
    window.__ocrController = controller;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        const row = {
          url: String(args[0]),
          terminateCalls: 0,
          stateAfter: null,
        };
        window.__workerRecords.push(row);
        const nativeTerminate = this.terminate.bind(this);
        this.terminate = () => {
          row.terminateCalls++;
          nativeTerminate();
        };
        if (
          window.__abortOnWorker &&
          String(args[0]).includes("/ocr/worker.min.js")
        ) {
          window.__abortOnWorker = false;
          setTimeout(() => controller.abort(), 0);
        }
      }
    };
    const api = await import(chrome.runtime.getURL("src/documents/pdf.js"));
    let outcome;
    try {
      const model = await api.openPDF(
        "cancel-while-ocr-starts.pdf",
        new Uint8Array(payload),
        {
          signal: controller.signal,
          onProgress: ({ stage }) => {
            if (stage === "本地OCR") window.__abortOnWorker = true;
          },
        },
      );
      await model.dispose();
      outcome = { resolved: true };
    } catch (e) {
      outcome = { rejected: true, code: e.code, message: e.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { ...outcome, workers: window.__workerRecords };
  }, bytes);
  const leasePage = await context.newPage();
  await leasePage.goto(`chrome-extension://${id}/src/ui/workbench.html`);
  const session = await leasePage.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type: "ASR_CREATE",
    });
    if (!response?.ok) throw Error(JSON.stringify(response));
    const port = chrome.runtime.connect({ name: "bt-media-session" });
    port.postMessage({ sessionId: response.data.id });
    return { id: response.data.id };
  });
  const beforeClose = await leasePage.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("bt-next-media", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise((resolve, reject) => {
      const r = db.transaction("records").objectStore("records").get(id);
      r.onsuccess = () => resolve(Boolean(r.result));
      r.onerror = () => reject(r.error);
    });
  }, session.id);
  await leasePage.close();
  const cleanupPage = await context.newPage();
  await cleanupPage.goto(`chrome-extension://${id}/src/ui/options.html`);
  const leaseCleanup = await cleanupPage.evaluate(async (sessionId) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("bt-next-media", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (let i = 0; i < 60; i++) {
      const exists = await new Promise((resolve, reject) => {
        const r = db
          .transaction("records")
          .objectStore("records")
          .get(sessionId);
        r.onsuccess = () => resolve(Boolean(r.result));
        r.onerror = () => reject(r.error);
      });
      if (!exists) return { removed: true, attempts: i + 1 };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { removed: false, attempts: 60 };
  }, session.id);
  await fs.writeFile(
    path.join(work, "translated-active-content.pdf"),
    new Uint8Array(translatedActiveBytes),
  );
  const report = {
    browser: context.browser().version(),
    extensionId: id,
    chineseOcr: ocr,
    initCancellation: cancellation,
    pdfExportActiveContent: {
      outputPages: activeOut.getPageCount(),
      annotationRetained: Boolean(annots),
      annotationAction: copiedAction,
    },
    mediaLease: {
      sessionId: session.id,
      existsBeforeClose: beforeClose,
      afterClose: leaseCleanup,
    },
    generatedPdf: path.join(work, "chinese-scan.pdf"),
  };
  await fs.writeFile(
    path.join(work, "audit-results.json"),
    JSON.stringify(report, null, 2),
  );
  assert.ok(
    ocr.segments
      .map((s) => s.text)
      .join("")
      .replace(/\s/g, "")
      .includes("文档识别成功"),
  );
  assert.equal(cancellation.code, "CANCELLED");
  assert.ok(
    cancellation.workers
      .filter((w) => w.url.includes("/ocr/"))
      .every((w) => w.terminateCalls > 0),
    "OCR initialization cancellation must terminate its worker",
  );
  assert.equal(
    Boolean(annots),
    false,
    "export must remove active source annotations",
  );
  assert.equal(leaseCleanup.removed, true);
  console.log(
    JSON.stringify(
      {
        browser: report.browser,
        checks: [
          "Chinese scan OCR",
          "OCR init cancellation closes worker",
          "PDF export removes active annotations",
          "workbench close removes audio session",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await context?.close();
}
