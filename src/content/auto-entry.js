// Small isolated bootstrap; language detection and translation authorization
// happen in the background. A hidden tab never starts paid work.
(() => {
  if (window !== top || globalThis.__btNextAutoLoaded) return;
  globalThis.__btNextAutoLoaded = true;
  let url = location.href,
    attempted = false,
    pending = false,
    timer,
    observer;
  function sample() {
    const root =
      document.querySelector('main,article,[role="main"]') || document.body;
    if (!root) return "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      pieces = [];
    let chars = 0;
    for (let node; chars < 3600 && (node = walker.nextNode()); ) {
      const element = node.parentElement;
      if (
        !element ||
        element.closest(
          'nav,header,footer,aside,script,style,pre,code,textarea,input,select,button,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[data-bt-next]',
        )
      )
        continue;
      const text = node.textContent.trim();
      if (text) {
        pieces.push(text);
        chars += text.length;
      }
    }
    return pieces.join(" ").slice(0, 4000);
  }
  async function attempt() {
    if (
      attempted ||
      pending ||
      document.visibilityState !== "visible" ||
      globalThis.__btNextAutoSuppressed === location.href
    )
      return;
    const text = sample();
    if ((text.match(/\p{L}/gu) || []).length < 40) return;
    const currentURL = location.href;
    pending = true;
    try {
      const reply = await chrome.runtime.sendMessage({
        channel: "BT_BG",
        type: "AUTO_PAGE_READY",
        url: currentURL,
        declared: document.documentElement.lang.slice(0, 64),
        sample: text,
      });
      if (location.href !== currentURL) return;
      attempted = reply?.data?.reason !== "background";
      globalThis.__btNextAutoReason = reply?.data?.reason;
      if (!reply?.ok) {
        globalThis.__btNextAutoError = reply?.error?.code || "INTERRUPTED";
      } else if (reply.data.reason === "configuration")
        globalThis.__btNextAutoError = "CONFIG_INVALID";
      else if (reply.data.reason === "permission")
        globalThis.__btNextAutoError = "PERMISSION_MISSING";
      else delete globalThis.__btNextAutoError;
    } catch {
      globalThis.__btNextAutoError = "INTERRUPTED";
      attempted = true;
    } finally {
      pending = false;
    }
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void attempt(), 25);
  };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message.channel !== "BT_AUTO")
      return;
    if (
      message.type === "CONFIGURATION_CHANGED" &&
      globalThis.__btNextAutoReason === "configuration" &&
      globalThis.__btNextAutoSuppressed !== location.href
    ) {
      attempted = false;
      delete globalThis.__btNextAutoError;
      schedule();
    }
    if (message.type === "ACTIVATED" && !attempted) schedule();
    reply({ ok: true });
  });
  observer = new MutationObserver(() => {
    if (!attempted) schedule();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("visibilitychange", schedule);
  const routes = setInterval(() => {
    if (location.href !== url) {
      url = location.href;
      attempted = false;
      schedule();
    }
  }, 400);
  addEventListener("pagehide", () => {
    clearInterval(routes);
    clearTimeout(timer);
    observer.disconnect();
  });
  schedule();
})();
