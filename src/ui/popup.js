import { providers } from "../providers/registry.js";
import { setupVideoPanel } from "./video-popup.js";
import { mountAutoSwitch } from "./auto-switch.js";
import { mountQuickSettings } from "./quick-settings.js";
const $ = (id) => document.getElementById(id);
let tabId,
  busy = false,
  state = { phase: "idle" };
const labels = {
  idle: "尚未开始",
  skipped_language: "当前页面为目标语言或语言不确定，未自动翻译",
  scanning: "扫描正文",
  translating: "正在翻译",
  waiting_visible: "等待你滚动到更多正文",
  paused_budget: "本轮预算已用完，可继续下一轮",
  complete: "当前已扫描内容完成",
  partial_error: "部分段落失败",
  error: "翻译失败",
  cancelled: "已停止",
  interrupted: "请求已中断，结果未知，需重新开始",
};
async function send(type, data = {}) {
  const r = await chrome.runtime.sendMessage({
    channel: "BT_BG",
    type,
    tabId,
    ...data,
  });
  if (!r.ok) throw Object.assign(Error(r.error.message), r.error);
  return r.data;
}
function display(s) {
  state = s;
  $("status").textContent =
    (labels[s.phase] || s.phase) +
    (s.counts
      ? `\n已翻译 ${s.counts.translated} 段 · 失败 ${s.counts.error} 段 · 待处理 ${s.counts.pending} 段`
      : "") +
    (s.budget
      ? `\n第 ${s.budget.round} 轮：已请求 ${s.budget.segmentsUsed} 片 / ${s.budget.codePointsUsed} 字符`
      : "") +
    (s.error ? "\n" + s.error.code + "：" + s.error.message : "") +
    (s.cacheDegraded ? "\n缓存不可用，正在使用真实请求。" : "");
  $("retry").disabled =
    !s.counts?.error ||
    s.fatal ||
    ["interrupted", "cancelled"].includes(s.phase);
  $("continue").disabled = !s.budgetBlocked || s.fatal || s.halted;
}
async function run(type) {
  if (busy) return;
  busy = true;
  try {
    display(await send(type));
  } catch (e) {
    $("status").textContent = (e.code || "ERROR") + "：" + e.message;
  } finally {
    busy = false;
  }
}
for (const [id, type] of Object.entries({
  start: "START",
  stop: "STOP",
  restore: "RESTORE",
  retry: "RETRY",
  continue: "CONTINUE",
}))
  $(id).onclick = () => void run(type);
$("settings").onclick = () => chrome.runtime.openOptionsPage();
$("workbench").onclick = () => void send("OPEN_WORKBENCH");
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const c = await send("CONFIG");
  $("connection").textContent =
    providers[c.provider].label +
    " → " +
    c.target +
    (c.model ? " · " + c.model : "");
  $("start").disabled = !c.hasKey;
  display(await send("STATUS"));
} catch (e) {
  $("status").textContent = e.message;
}
setupVideoPanel({ send });
await mountAutoSwitch({ send });
await mountQuickSettings({ send });
setInterval(() => {
  if (!busy)
    send("STATUS").then(display, (error) =>
      display({ phase: "interrupted", error }),
    );
}, 750);
