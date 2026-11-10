import { Extractor } from "./extractor.js";
import { Renderer } from "./renderer.js";
import { Session } from "./scheduler.js";
let session, observer, mutations, port, timer, routeTimer;
const renderer = new Renderer();
function disconnect() {
  observer?.disconnect();
  mutations?.disconnect();
  clearTimeout(timer);
  clearInterval(routeTimer);
  const old = port;
  port = null;
  old?.disconnect();
}
function rpc(type, data = {}) {
  return new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      session?.interrupt();
      reject(Object.assign(Error(), { code: "OUTCOME_UNKNOWN" }));
    }, 30000);
    chrome.runtime
      .sendMessage({ channel: "BT_BG", type, ...data, jobId: session?.job.id })
      .then(
        (reply) => {
          clearTimeout(watchdog);
          if (!reply?.ok)
            reject(
              Object.assign(Error(), reply?.error || { code: "INTERRUPTED" }, {
                budget: reply?.budget,
              }),
            );
          else resolve(reply.data);
        },
        () => {
          clearTimeout(watchdog);
          reject(Object.assign(Error(), { code: "INTERRUPTED" }));
        },
      );
  });
}
function initialize(job) {
  delete globalThis.__btNextAutoError;
  session?.stop();
  disconnect();
  renderer.restore();
  const current = new Session({
    job,
    extractor: new Extractor(),
    renderer,
    send: rpc,
  });
  session = current;
  const initialURL = location.href;
  void import(chrome.runtime.getURL("src/content/learning.js"))
    .then((m) => m.startLearning(true))
    .catch((error) => console.error("Learning initialization failed", error.message));
  port = chrome.runtime.connect({ name: "bt-next" });
  port.postMessage({ jobId: job.id });
  port.onMessage.addListener((m) => {
    if (m.epoch !== job.epoch) current.interrupt();
  });
  port.onDisconnect.addListener(() => {
    if (port && session === current) current.interrupt();
  });
  observer = new IntersectionObserver(
    (entries) => {
      if (session !== current) return;
      for (const e of entries) {
        const record = current.extractor.records.get(e.target);
        if (record) {
          if (e.isIntersecting) current.visible.add(record.id);
          else current.visible.delete(record.id);
          if (
            e.isIntersecting &&
            e.boundingClientRect.bottom > 0 &&
            e.boundingClientRect.top < innerHeight
          )
            current.onscreen.add(record.id);
          else current.onscreen.delete(record.id);
        }
      }
      void current.pump();
    },
    { rootMargin: "400px" },
  );
  const scan = () => {
    if (current.cancelled || current.interrupted) return;
    for (const r of current.scan()) {
      observer.observe(r.element);
      const rect = r.element.getBoundingClientRect();
      if (
        rect.bottom > -400 &&
        rect.top < innerHeight + 400 &&
        rect.right > 0 &&
        rect.left < innerWidth
      )
        current.visible.add(r.id);
      else current.visible.delete(r.id);
      if (
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        rect.right > 0 &&
        rect.left < innerWidth
      )
        current.onscreen.add(r.id);
      else current.onscreen.delete(r.id);
    }
    void current.pump();
  };
  scan();
  mutations = new MutationObserver((records) => {
    const changed = records.some((r) => {
      const element =
        r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (element?.closest("[data-bt-next]")) return false;
      if (
        r.type === "childList" &&
        [...r.addedNodes, ...r.removedNodes].every(
          (n) => n.nodeType === 1 && n.hasAttribute("data-bt-next"),
        )
      )
        return false;
      return true;
    });
    if (changed) {
      clearTimeout(timer);
      timer = setTimeout(scan, 500);
    }
  });
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  routeTimer = setInterval(() => {
    if (location.href !== initialURL) {
      current.stop();
      disconnect();
      void rpc("CANCEL").catch(() => {});
    }
  }, 500);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.channel !== "BT_PAGE") return;
  const action = async () => {
    if (message.type === "INIT") {
      initialize(message.job);
      return session.state();
    }
    if (message.type === "STATUS") return session?.state() || { phase: "idle" };
    if (message.type === "STOP" || message.type === "RESTORE") {
      globalThis.__btNextAutoSuppressed = location.href;
      delete globalThis.__btNextAutoError;
      session?.stop();
      disconnect();
      if (message.type === "RESTORE") renderer.restore();
      await rpc("CANCEL").catch(() => {});
    } else if (message.type === "RETRY") await session?.retry();
    else if (message.type === "CONTINUE") await session?.continue();
    return session?.state() || { phase: "idle" };
  };
  action().then(
    (data) => reply({ ok: true, data }),
    () =>
      reply({
        ok: false,
        error: { code: "INTERRUPTED", message: "操作中断，请重新开始。" },
      }),
  );
  return true;
});
addEventListener("pagehide", () => {
  session?.stop();
  disconnect();
  void rpc("CANCEL").catch(() => {});
});
