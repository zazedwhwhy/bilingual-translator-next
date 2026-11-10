import * as pdfjs from "../vendor/pdf.mjs";
import { PDFDocument, PDFName, fontkit, rgb } from "../vendor/pdf-export.js";
import Tesseract from "../vendor/ocr/tesseract.esm.min.js";
import { Failure, fail } from "../shared/core.js";
const asset = (path) => new URL("../vendor/" + path, import.meta.url).href;
const { createWorker } = Tesseract;
pdfjs.GlobalWorkerOptions.workerSrc = asset("pdf.worker.mjs");
function abortable(promise, signal, cleanup = () => {}) {
  if (signal?.aborted) {
    cleanup();
    return Promise.reject(new Failure("CANCELLED", "操作已停止"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new Failure("CANCELLED", "操作已停止"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener("abort", abort));
  });
}
function paragraphs(items) {
  const lines = [];
  let line = "",
    lastY = null,
    lastHeight = 0;
  const out = [];
  let block = "",
    blockX = null,
    previousY = null;
  const flushLine = () => {
    if (line.trim())
      lines.push({
        text: line.trim(),
        y: lastY,
        height: lastHeight,
        x: blockX ?? 0,
      });
    line = "";
  };
  for (const item of items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) flushLine();
    if (!line) blockX = item.transform[4];
    line += (line ? " " : "") + item.str;
    lastY = y;
    lastHeight = Math.max(8, item.height || Math.abs(item.transform[0]));
    if (item.hasEOL) flushLine();
  }
  flushLine();
  let previous;
  for (const row of lines) {
    if (
      previous &&
      (Math.abs(row.y - previous.y) >
        Math.max(row.height, previous.height) * 1.8 ||
        Math.abs(row.x - previous.x) > 50)
    ) {
      if (block.trim()) out.push(block.trim());
      block = "";
    }
    block += (block ? "\n" : "") + row.text;
    previous = row;
  }
  if (block.trim()) out.push(block.trim());
  return out;
}
export async function openPDF(
  name,
  bytes,
  {
    ocr = true,
    signal,
    onProgress = () => {},
    ocrLanguage = "eng+chi_sim",
  } = {},
) {
  if (bytes.length > 64 * 1024 * 1024) fail("FILE_LIMIT", "PDF超过64 MiB上限");
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    cMapUrl: asset("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts/"),
    wasmUrl: asset("wasm/"),
  });
  let pdf, worker;
  try {
    pdf = await abortable(task.promise, signal, () => void task.destroy());
    if (pdf.numPages > 1000) fail("FILE_LIMIT", "PDF超过1000页，请拆分文件");
    const model = {
      kind: "pdf",
      name,
      bytes,
      segments: [],
      pages: [],
      pdf,
      dispose: () => task.destroy(),
    };
    for (let number = 1; number <= pdf.numPages; number++) {
      if (signal?.aborted) throw new Failure("CANCELLED", "操作已停止");
      onProgress({ stage: "提取PDF", page: number, total: pdf.numPages });
      const page = await pdf.getPage(number),
        text = await page.getTextContent();
      let blocks = paragraphs(text.items),
        method = "text";
      if (!blocks.length && ocr) {
        method = "ocr";
        onProgress({ stage: "本地OCR", page: number, total: pdf.numPages });
        const viewport = page.getViewport({
            scale: Math.min(
              2,
              Math.sqrt(8000000 / (page.view[2] * page.view[3])),
            ),
          }),
          canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const render = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
        });
        await abortable(render.promise, signal, () => render.cancel());
        if (!worker) {
          const initializing = createWorker(ocrLanguage, 1, {
            workerPath: asset("ocr/worker.min.js"),
            corePath: asset("ocr/tesseract-core-lstm.wasm.js"),
            langPath: asset("ocr/"),
            gzip: false,
            workerBlobURL: false,
            logger: () => {},
          });
          worker = await abortable(initializing, signal, () => {
            // createWorker exposes the worker only when initialization completes.
            // Cancellation must also dispose a late successful initialization.
            void initializing
              .then((value) => value.terminate())
              .catch(() => {});
          });
        }
        let result;
        try {
          result = await abortable(
            worker.recognize(canvas),
            signal,
            () => void worker.terminate(),
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new Failure(
            "OCR_FAILED",
            "第" + number + "页文字识别失败，请重试。",
          );
        } finally {
          canvas.width = canvas.height = 0;
        }
        blocks = result.data.text
          .split(/\n\s*\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const ids = [];
      for (const text of blocks) {
        if (!/[\p{L}]/u.test(text)) continue;
        const id = "pdf" + model.segments.length;
        model.segments.push({
          id,
          text,
          location: "第 " + number + " 页" + (method === "ocr" ? " · OCR" : ""),
          page: number,
          method,
        });
        ids.push(id);
      }
      model.pages.push({
        number,
        ids,
        status: ids.length ? "ready" : ocr ? "no_text" : "ocr_needed",
      });
      page.cleanup();
    }
    return model;
  } catch (error) {
    try {
      await task.destroy();
    } catch {
      /* Preserve the parsing/OCR error. */
    }
    throw error;
  } finally {
    if (worker) await worker.terminate();
  }
}
export async function renderPDFPage(model, number, canvas) {
  const page = await model.pdf.getPage(number),
    viewport = page.getViewport({ scale: 1.25 });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport })
    .promise;
  return viewport;
}
function requireTranslations(model, map) {
  for (const s of model.segments)
    if (!map.get(s.id)?.trim())
      fail("TRANSLATION_INCOMPLETE", "仍有未完成的PDF段落");
}
export async function exportPDF(model, map) {
  requireTranslations(model, map);
  const source = await PDFDocument.load(model.bytes),
    output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(
    await (await fetch(asset("NotoSansCJKsc-Regular.otf"))).arrayBuffer(),
    { subset: true },
  );
  const glyphs = new Set(font.getCharacterSet());
  for (const segment of model.segments)
    for (const c of map.get(segment.id))
      if (
        c !== "\n" &&
        c !== "\r" &&
        c !== "\t" &&
        !glyphs.has(c.codePointAt(0))
      )
        fail(
          "FONT_UNSUPPORTED",
          "当前PDF字体不能显示部分字符，请改为导出HTML。",
        );
  for (let index = 0; index < source.getPageCount(); index++) {
    const [original] = await output.copyPages(source, [index]);
    // Preserve page appearance while excluding interactive source actions/files.
    original.node.delete(PDFName.of("Annots"));
    original.node.delete(PDFName.of("AA"));
    output.addPage(original);
    const segments = model.segments.filter((s) => s.page === index + 1);
    if (!segments.length) continue;
    let page, y;
    const newPage = () => {
      page = output.addPage([595, 842]);
      y = 790;
      page.drawText("Translation / Page " + (index + 1), {
        x: 44,
        y,
        size: 13,
        font,
        color: rgb(0.2, 0.35, 0.28),
      });
      y -= 30;
    };
    newPage();
    for (const segment of segments) {
      const paragraphs = map.get(segment.id).replace(/\r/g, "").split("\n");
      for (const paragraph of paragraphs) {
        let line = "";
        for (const char of paragraph) {
          if (line && font.widthOfTextAtSize(line + char, 12) > 507) {
            if (y < 50) newPage();
            page.drawText(line, { x: 44, y, size: 12, font });
            y -= 20;
            line = "";
          }
          line += char;
        }
        if (y < 50) newPage();
        if (line) page.drawText(line, { x: 44, y, size: 12, font });
        y -= 20;
      }
      y -= 12;
    }
  }
  return output.save();
}
