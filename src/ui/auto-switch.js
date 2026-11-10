import { AUTO_ORIGINS } from "../shared/auto.js";
export async function mountAutoSwitch({ send }) {
  const control = document.getElementById("auto-translate"),
    status = document.getElementById("auto-status");
  control.disabled = true;
  function display(state) {
    control.checked = state.enabled;
    status.textContent =
      state.error?.message ||
      (state.enabled
        ? state.configured === false
          ? "已开启，但尚未配置翻译服务。请先保存服务连接。"
          : "已开启：打开外语网页后自动翻译可见正文。"
        : "已关闭：需要时点击“翻译此页”。");
  }
  try {
    display(await send("AUTO_CONFIG"));
  } catch (error) {
    status.textContent = "无法读取自动翻译设置：" + error.message;
    return;
  }
  control.disabled = false;
  control.onchange = () => {
    const enabled = control.checked;
    // Request synchronously from the checkbox gesture, before any await.
    const permission = enabled
      ? chrome.permissions.request({ origins: AUTO_ORIGINS })
      : Promise.resolve(true);
    control.disabled = true;
    void (async () => {
      try {
        if (!(await permission)) {
          control.checked = false;
          status.textContent = "未授予网页访问权限，自动翻译保持关闭。";
          return;
        }
        display(await send("AUTO_SET", { enabled }));
        if (enabled) status.textContent += " 当前已打开的网页请刷新一次。";
      } catch (error) {
        status.textContent = (error.code || "ERROR") + "：" + error.message;
        try {
          control.checked = (await send("AUTO_CONFIG")).enabled;
        } catch {
          /* Keep the original setting error visible. */
        }
      } finally {
        control.disabled = false;
      }
    })();
  };
}
