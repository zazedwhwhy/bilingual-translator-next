import { mountCapture } from "./capture-workbench.js";
import {
  openTextDocument,
  openXMLDocument,
  exportTextDocument,
  exportXMLDocument,
  bilingualHTML,
} from "../documents/formats.js";
import { openPDF, renderPDFPage, exportPDF } from "../documents/pdf.js";
import { DocumentRunner } from "../documents/runner.js";
import { mountSubtitles } from "./subtitles-workbench.js";
import { mountAsrWorkbench } from "./asr-workbench.js";
const $ = (id) => document.getElementById(id);
let documentModel,
  importController,
  currentPage = 1,
  renderVersion = 0;
function status(text, phase) {
  $("document-status").textContent = text;
  $("document-status").dataset.phase = phase;
}
const jobLeases = new Map();
function releaseJob(id) {
  const lease = jobLeases.get(id);
  if (!lease) return;
  jobLeases.delete(id);
  clearInterval(lease.timer);
  lease.port.disconnect();
}
function leaseJob(job, purpose) {
  const port = chrome.runtime.connect({ name: "bt-next" }),
    lease = { port };
  jobLeases.set(job.id, lease);
  const heartbeat = () => {
    try {
      port.postMessage({ jobId: job.id });
    } catch {
      releaseJob(job.id);
    }
  };
  port.onDisconnect.addListener(() => {
    if (!jobLeases.has(job.id)) return;
    jobLeases.delete(job.id);
    clearInterval(lease.timer);
    const target = purpose === "subtitles" ? subtitles.runner : runner;
    target.generation++;
    target.job = null;
    target.phase = "interrupted";
    target.errors.set("connection", {
      code: "INTERRUPTED",
      message: "后台连接中断，请重新开始；远端可能已处理。",
    });
    target.emit();
  });
  heartbeat();
  lease.timer = setInterval(heartbeat, 15000);
}
function rpc(type, data = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          Object.assign(Error("请求结果未知，请重新开始，可能重复计费。"), {
            code: "OUTCOME_UNKNOWN",
          }),
        ),
      30000,
    );
    chrome.runtime.sendMessage({ channel: "BT_BG", type, ...data }).then(
      (r) => {
        clearTimeout(timer);
        if (!r?.ok)
          reject(
            Object.assign(Error(r?.error?.message || "请求中断"), r?.error, {
              budget: r?.budget,
            }),
          );
        else {
          if (type === "WB_START") leaseJob(r.data, data.purpose);
          if (type === "WB_CANCEL") releaseJob(data.jobId);
          resolve(r.data);
        }
      },
      () => {
        clearTimeout(timer);
        reject(
          Object.assign(Error("后台连接已中断，请重新开始。"), {
            code: "INTERRUPTED",
          }),
        );
      },
    );
  });
}
const runner = new DocumentRunner(rpc, update);
function setButtons() {
  const complete =
    !!documentModel?.segments.length &&
    runner.translations.size === documentModel.segments.length;
  $("document-translate").disabled =
    !documentModel?.segments.length || runner.running;
  $("document-export").disabled = !complete;
  $("document-html").disabled = !complete;
  $("document-continue").disabled = runner.phase !== "paused_budget";
  $("document-retry").disabled =
    runner.phase !== "error" ||
    [...runner.errors.values()].some((e) =>
      [
        "AUTH_FAILED",
        "PERMISSION_MISSING",
        "QUOTA_EXCEEDED",
        "CONFIG_INVALID",
      ].includes(e.code),
    );
}
function update() {
  if (!documentModel) return;
  const labels = {
    starting: "准备翻译",
    translating: "正在翻译",
    paused_budget: "本轮达到上限，请点击继续下一轮",
    complete: "翻译完成",
    error: "翻译失败，可检查错误后重试",
    interrupted: "请求结果未知，请显式重新开始",
    cancelled: "已停止",
  };
  let text =
    (labels[runner.phase] || runner.phase) +
    " · " +
    runner.translations.size +
    "/" +
    documentModel.segments.length +
    " 段";
  if (runner.budget)
    text +=
      " · 第" +
      runner.budget.round +
      "轮，已发送" +
      runner.budget.segmentsUsed +
      "片";
  const error = [...runner.errors.values()][0];
  if (error) text += "\n" + error.code + "：" + error.message;
  status(text, runner.phase);
  renderSegments();
  setButtons();
}
function renderSegments() {
  const root = $("document-content");
  const records =
    documentModel?.segments.filter(
      (s) => documentModel.kind !== "pdf" || s.page === currentPage,
    ) || [];
  const fragment = document.createDocumentFragment();
  for (const s of records) {
    const article = document.createElement("article");
    article.className = "document-row";
    const location = document.createElement("small"),
      source = document.createElement("p"),
      target = document.createElement("p");
    location.textContent = s.location;
    source.className = "document-source";
    source.textContent = s.text;
    target.className = "document-target";
    target.textContent = runner.translations.get(s.id) || "等待翻译";
    const error = runner.errors.get(s.id);
    if (error) {
      target.classList.add("document-error");
      target.textContent = error.message;
    }
    article.append(location, source, target);
    fragment.append(article);
  }
  root.replaceChildren(fragment);
}
async function renderPage() {
  if (documentModel?.kind !== "pdf") return;
  const version = ++renderVersion;
  $("pdf-page").textContent =
    "第 " + currentPage + " / " + documentModel.pages.length + " 页";
  $("pdf-previous").disabled = currentPage <= 1;
  $("pdf-next").disabled = currentPage >= documentModel.pages.length;
  const canvas = document.createElement("canvas");
  canvas.id = "pdf-canvas";
  await renderPDFPage(documentModel, currentPage, canvas);
  if (version === renderVersion) $("pdf-canvas").replaceWith(canvas);
  renderSegments();
}
async function action(fn) {
  try {
    await fn();
  } catch (error) {
    status((error.code || "ERROR") + "：" + error.message, "error");
    setButtons();
  }
}
$("document-file").onchange = () =>
  void action(async () => {
    const file = $("document-file").files[0];
    if (!file) return;
    importController?.abort();
    await runner.stop(false);
    await documentModel?.dispose?.();
    documentModel = null;
    runner.translations.clear();
    runner.errors.clear();
    setButtons();
    importController = new AbortController();
    const signal = importController.signal;
    if (file.size > 64 * 1024 * 1024)
      throw Object.assign(Error("文件超过64 MiB，请拆分后导入。"), {
        code: "FILE_LIMIT",
      });
    status("正在本地解析 " + file.name, "loading");
    const bytes = new Uint8Array(await file.arrayBuffer()),
      extension = file.name.toLowerCase().split(".").pop();
    let model;
    if (extension === "pdf")
      model = await openPDF(file.name, bytes, {
        signal,
        ocr: $("document-ocr").checked,
        onProgress: (p) =>
          status(
            p.stage + " · 第 " + p.page + "/" + p.total + " 页",
            "loading",
          ),
      });
    else if (["txt", "md"].includes(extension))
      model = openTextDocument(
        file.name,
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    else model = openXMLDocument(file.name, bytes);
    if (signal.aborted) {
      await model.dispose?.();
      return;
    }
    documentModel = model;
    currentPage = 1;
    $("pdf-preview").hidden = $("pdf-navigation").hidden = model.kind !== "pdf";
    renderSegments();
    if (model.kind === "pdf") await renderPage();
    status(
      file.name +
        " · 已读取 " +
        model.segments.length +
        " 段" +
        (model.pages
          ? " · " +
            model.pages.filter((p) => p.status !== "ready").length +
            " 页无可识别文字"
          : ""),
      "ready",
    );
    setButtons();
  });
$("document-translate").onclick = () =>
  void action(() => runner.start(documentModel));
$("document-stop").onclick = () => {
  importController?.abort();
  void action(() => runner.stop());
};
$("document-continue").onclick = () => void action(() => runner.continue());
$("document-retry").onclick = () => void action(() => runner.retry());
$("pdf-previous").onclick = () =>
  void action(async () => {
    currentPage--;
    await renderPage();
  });
$("pdf-next").onclick = () =>
  void action(async () => {
    currentPage++;
    await renderPage();
  });
function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type }),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$("document-export").onclick = () =>
  void action(async () => {
    if (!documentModel) return;
    let bytes,
      type = "application/octet-stream";
    if (documentModel.kind === "pdf") {
      bytes = await exportPDF(documentModel, runner.translations);
      type = "application/pdf";
    } else if (["txt", "md"].includes(documentModel.kind)) {
      bytes = exportTextDocument(documentModel, runner.translations);
      type = "text/plain;charset=utf-8";
    } else bytes = exportXMLDocument(documentModel, runner.translations);
    const name = documentModel.name.replace(/(\.[^.]+)$/, "-双语$1");
    download(bytes, name, type);
  });
$("document-html").onclick = () =>
  void action(() =>
    download(
      bilingualHTML(documentModel, runner.translations),
      documentModel.name.replace(/\.[^.]+$/, "") + "-双语.html",
      "text/html;charset=utf-8",
    ),
  );
$("open-settings").onclick = () => chrome.runtime.openOptionsPage();
const subtitles = mountSubtitles({ rpc, download });
const uploads = mountAsrWorkbench({ rpc, subtitles });
mountCapture({ rpc, subtitles, uploads });
addEventListener("pagehide", () => {
  for (const id of jobLeases.keys()) releaseJob(id);
  importController?.abort();
  void runner.stop(false);
  void documentModel?.dispose?.();
});
