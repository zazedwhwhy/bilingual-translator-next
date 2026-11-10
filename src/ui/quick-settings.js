import { languages } from "../providers/registry.js";
import { AUTO_ORIGINS } from "../shared/auto.js";
export async function mountQuickSettings({ send }) {
  const status = document.getElementById("quick-status");
  const controls = ["selection", "hover", "input"].map((mode) => ({
    mode,
    control: document.getElementById("quick-" + mode),
  }));
  const target = document.getElementById("quick-target");
  if (!status || !target) return;
  const all = [...controls.map((row) => row.control), target];
  if (!target.options.length)
    for (const language of languages)
      target.add(
        new Option(
          language === "en"
            ? "English"
            : language === "zh-CN"
              ? "简体中文"
              : language,
          language,
        ),
      );
  let state;
  const display = (next) => {
    state = next;
    for (const { mode, control } of controls) control.checked = next[mode];
    target.value = next.inputTarget;
    status.textContent =
      next.error?.message ||
      (next.ready
        ? "已启用所选入口，当前打开的普通网页立即生效。"
        : "开启时需一次性允许访问普通网页。");
    if (next.ready && next.configured === false)
      status.textContent += " 请先保存翻译服务连接。";
  };
  all.forEach((control) => (control.disabled = true));
  try {
    display(await send("INTERACTION_CONFIG"));
  } catch (error) {
    status.textContent = "无法读取快捷翻译设置：" + error.message;
    return;
  }
  all.forEach((control) => (control.disabled = false));
  const save = (patch, permission) => {
    all.forEach((control) => (control.disabled = true));
    void (async () => {
      try {
        if (!(await permission)) {
          display(state);
          status.textContent = "未授予网页权限，未开启此入口。";
          return;
        }
        display(await send("INTERACTION_SET", { preferences: patch }));
      } catch (error) {
        const original = (error.code || "ERROR") + "：" + error.message;
        try {
          display(await send("INTERACTION_CONFIG"));
        } catch {
          /* Preserve the actual save error. */
        }
        status.textContent = original;
      } finally {
        all.forEach((control) => (control.disabled = false));
      }
    })();
  };
  for (const { mode, control } of controls)
    control.onchange = () => {
      const enabled = control.checked;
      const permission = enabled
        ? chrome.permissions.request({ origins: AUTO_ORIGINS })
        : Promise.resolve(true);
      save({ [mode]: enabled }, permission);
    };
  target.onchange = () =>
    save({ inputTarget: target.value }, Promise.resolve(true));
}
