void (async () => {
  if (!globalThis.__btNextInteractionsLoading)
    globalThis.__btNextInteractionsLoading = import(
      chrome.runtime.getURL("src/content/interactions.js")
    ).then((module) => module.mountInteractions());
  const controller = await globalThis.__btNextInteractionsLoading;
  await controller.refresh();
})().catch(() => {
  if (document.querySelector("[data-bt-interaction-error]")) return;
  const notice = document.createElement("aside");
  notice.setAttribute("data-bt-next", "interaction-error");
  notice.setAttribute("data-bt-interaction-error", "");
  notice.setAttribute("role", "status");
  notice.style.cssText =
    "position:fixed;inset:auto 12px 12px auto;max-width:min(390px,calc(100vw - 24px));padding:16px;background:#fff;color:#20372f;font:14px/1.6 system-ui,sans-serif;box-shadow:0 8px 28px #142d2229;border-radius:12px;z-index:2147483647";
  const message = document.createElement("p");
  message.textContent =
    "快捷翻译未启动。请检查扩展设置，或保存当前输入后刷新网页。";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭提示";
  close.addEventListener("click", (event) => {
    if (event.isTrusted) notice.remove();
  });
  notice.append(message, close);
  document.documentElement.append(notice);
});
