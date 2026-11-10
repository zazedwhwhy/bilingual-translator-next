import { providers, languages } from "../providers/registry.js";
import { saveWithPermission } from "./permission-save.js";
import { mountAsrOptions } from "./asr-options.js";
import { mountAutoSwitch } from "./auto-switch.js";
import { mountQuickSettings } from "./quick-settings.js";
let grantedOrigins;
const $ = (id) => document.getElementById(id);
const initializingControls = [
  ...document.querySelectorAll("input,select,button"),
];
initializingControls.forEach((control) => (control.disabled = true));
const names = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  ru: "Русский",
  pt: "Português",
  it: "Italiano",
  ar: "العربية",
};
for (const lang of languages)
  for (const id of ["source", "target"])
    $(id).add(new Option(names[lang], lang));
async function send(type, data = {}) {
  const r = await chrome.runtime.sendMessage({
    channel: "BT_BG",
    type,
    ...data,
  });
  if (!r.ok) throw Object.assign(Error(r.error.message), r.error);
  return r.data;
}
function modelVisibility() {
  $("model-row").hidden = $("provider").value === "google";
}
function show(message) {
  $("status").textContent = message;
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    show((e.code || "ERROR") + "：" + (e.message || "操作失败"));
  }
}
$("provider").onchange = () => {
  $("key").value = "";
  $("model").value = "";
  modelVisibility();
  show("已更换表单服务，请填写对应密钥并保存。");
};
$("save").onclick = () => {
  if (!grantedOrigins) {
    show("正在读取配置，请稍后保存。");
    return;
  }
  const provider = $("provider").value;
  const origin = providers[provider].origin,
    alreadyGranted = grantedOrigins.has(origin);
  const config = {
    provider,
    model: $("model").value,
    secret: $("key").value,
    target: $("target").value,
    source: $("source").value,
    cacheEnabled: $("cache").checked,
  };
  const permission = chrome.permissions.request({
    origins: [providers[provider].origin],
  });
  show("正在保存…");
  void action(async () => {
    await saveWithPermission({
      granted: permission,
      origin,
      alreadyGranted,
      save: () => send("SAVE_CONFIG", { config }),
      isUsed: async (o) => {
        const c = await send("CONFIG");
        return c.hasKey && providers[c.provider].origin === o;
      },
      remove: (o) => chrome.permissions.remove({ origins: [o] }),
    });
    grantedOrigins = new Set((await chrome.permissions.getAll()).origins || []);
    $("key").value = "";
    await mountAutoSwitch({ send });
    await mountQuickSettings({ send });
    show("配置已保存。");
  });
};
$("test").onclick = () =>
  void action(async () => {
    show("正在发送固定测试句，可能计费…");
    const rows = await send("TEST_CONNECTION");
    show("测试成功：" + rows[0].text);
  });
$("clear-key").onclick = () =>
  void action(async () => {
    await send("CLEAR_KEY");
    $("key").value = "";
    show("密钥已移除，相关任务已停止。");
  });
$("clear-cache").onclick = () =>
  void action(async () => {
    await send("CLEAR_CACHE");
    show("缓存已清空。");
  });
$("diagnostics").onclick = () =>
  void action(async () => {
    $("diagnostic-output").value = JSON.stringify(
      await send("DIAGNOSTICS"),
      null,
      2,
    );
  });
await action(async () => {
  grantedOrigins = new Set((await chrome.permissions.getAll()).origins || []);
  const c = await send("CONFIG");
  $("provider").value = c.provider;
  $("model").value = c.model;
  $("source").value = c.source;
  $("target").value = c.target;
  $("cache").checked = c.cacheEnabled;
  modelVisibility();
  show(c.hasKey ? "已保存密钥。留空可以保留。" : "请先配置自己的服务。");
});
initializingControls.forEach((control) => (control.disabled = false));
await mountAutoSwitch({ send });
await mountQuickSettings({ send });
await mountAsrOptions();
