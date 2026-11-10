import { articleText, nearbyContext } from "./learning-context.js";
let instance;
const rpc = async (type, data = {}) => {
  const r = await chrome.runtime.sendMessage({
    channel: "BT_BG",
    type,
    ...data,
  });
  if (!r?.ok)
    throw Error(r?.error?.message || "学习连接中断，结果未知，请手动重试");
  return r.data;
};
const element = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
class LearningPage {
  constructor() {
    this.url = location.href;
    this.generation = 0;
    this.analyzed = new Set();
    this.host = element("div");
    this.host.dataset.btNext = "learning";
    this.host.hidden = true;
    this.root = this.host.attachShadow({ mode: "open" });
    const style = element(
      "style",
      ":host{all:initial;position:fixed;right:16px;bottom:18px;z-index:2147483646;font:14px/1.6 system-ui;color:#20372f}:host([hidden]){display:none!important}*{box-sizing:border-box}button,select{font:inherit;border:1px solid #8ba396;border-radius:7px;background:#fff;color:#20372f;padding:7px 11px;cursor:pointer;margin:4px}button:focus-visible{outline:3px solid #477b60}section{background:#fff;border:1px solid #bfd0c5;box-shadow:0 8px 28px #142d2229;border-radius:12px;padding:16px;width:380px;max-width:calc(100vw - 32px);max-height:75vh;overflow:auto}h2{font-size:18px;margin:4px}p{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #dde5df;padding:10px 0}.muted{color:#586c61;font-size:12px}[hidden]{display:none!important}",
    );
    this.root.append(style);
    this.launch = this.button("学英语", () => this.open());
    this.root.append(this.launch);
    document.documentElement.append(this.host);
    chrome.runtime.onMessage.addListener((m, s) => {
      if (
        s.id === chrome.runtime.id &&
        m.channel === "BT_LEARNING" &&
        m.type === "ANALYZE"
      )
        void this.analyze("recommend");
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.englishLearningV1)
        void this.refresh().catch((e) => this.error(e));
    });
    this.timer = setInterval(() => {
      if (this.url !== location.href) {
        this.url = location.href;
        this.generation++;
        this.panel?.remove();
        void rpc("LEARN_CANCEL").catch(() => {});
        this.analyzed.clear();
      }
    }, 500);
    window.addEventListener("pagehide", () => {
      clearInterval(this.timer);
      this.generation++;
      void rpc("LEARN_CANCEL").catch(() => {});
    });
  }
  button(text, fn) {
    const b = element("button", text);
    b.type = "button";
    b.onclick = (event) => {
      if (!event.isTrusted) return;
      Promise.resolve()
        .then(fn)
        .catch((e) => this.error(e));
    };
    return b;
  }
  error(e) {
    if (!this.panel?.isConnected) this.open();
    this.status.textContent = e.message;
  }
  async refresh() {
    const state = await rpc("LEARN_GET");
    this.state = state;
    this.host.hidden = !state.preferences.enabled;
    const body = articleText().toLowerCase();
    const seen = state.records.filter(
      (r) => r.learning && body.includes(r.text.toLowerCase()),
    ).length;
    this.launch.textContent = seen ? "学英语 · 重遇 " + seen + " 项" : "学英语";
    if (this.host.hidden) {
      this.generation++;
      this.panel?.remove();
    }
    return state;
  }
  open() {
    this.panel?.remove();
    this.panel = element("section");
    this.panel.setAttribute("aria-label", "英语学习");
    this.panel.append(element("h2", "读懂，也记住"));
    this.panel.append(
      this.button("收起", () => {
        this.panel.remove();
      }),
      this.button("学习库", () => rpc("LEARN_OPEN")),
    );
    this.status = element(
      "p",
      "正文分析最多读取前18000字符；额外请求使用当前文字模型。",
    );
    this.status.setAttribute("role", "status");
    this.status.className = "muted";
    this.panel.append(this.status);
    this.panel.append(
      this.button("推荐可学表达", () => this.analyze("recommend")),
      this.button("解释选中表达", () => this.explain()),
      this.button("文章练习", () => this.analyze("exercise")),
      this.button("停止分析", async () => {
        this.generation++;
        await rpc("LEARN_CANCEL");
        this.status.textContent = "已停止本次分析；远端可能已计费。";
      }),
      this.button("本页重遇", () => this.encounters()),
    );
    this.output = element("div");
    this.panel.append(this.output);
    this.root.append(this.panel);
    this.encounters();
  }
  encounters() {
    if (!this.output) return;
    this.output.replaceChildren();
    const text = articleText().toLowerCase();
    const rows = (this.state?.records || []).filter(
      (r) =>
        r.learning &&
        new RegExp(
          "(^|[^a-z])" +
            r.text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "(?=$|[^a-z])",
          "i",
        ).test(text),
    );
    if (!rows.length)
      this.output.append(element("p", "本页还没有遇见学习库中的表达。"));
    for (const row of rows) {
      const box = element("article");
      box.append(
        element("strong", row.text),
        element(
          "p",
          row.due <= Date.now()
            ? "到复习时间了，先想想它在文中的意思。"
            : "再次遇见：可以回忆，也可以跳过。",
        ),
      );
      box.append(
        this.button("揭晓", () => {
          box.replaceChildren(
            element("strong", row.text),
            element("p", row.translation),
            element("p", row.context),
          );
          for (const [label, rating] of [
            ["记得", "remember"],
            ["忘了", "forget"],
            ["跳过", "skip"],
          ])
            box.append(
              this.button(label, async () => {
                await rpc("LEARN_REVIEW", { id: row.id, rating });
                box.replaceChildren(
                  element(
                    "p",
                    rating === "skip"
                      ? "已跳过，计划未改变。"
                      : "已更新复习计划。",
                  ),
                );
              }),
            );
        }),
        this.button("跳过", () => box.remove()),
      );
      this.output.append(box);
    }
  }
  async explain() {
    const selection = getSelection();
    const selected = selection?.toString().trim();
    if (!selected || selection.anchorNode?.getRootNode() === this.root)
      throw Error("先在正文中选中一个词或表达，再点击解释。");
    const context = nearbyContext({ range: selection.getRangeAt(0) });
    if (!context) throw Error("请选择正文中的表达");
    await this.analyze(
      "explain",
      `Selected expression: ${selected.slice(0, 1000)}\nContext: ${context}`,
    );
  }
  async analyze(kind, source) {
    if (!(await this.refresh()).preferences.enabled) return;
    if (!this.panel?.isConnected) this.open();
    if (this.busy) throw Error("当前分析尚未结束");
    const input = source || articleText();
    if (!input.trim()) throw Error("当前页面没有可读取的正文");
    const gen = this.generation,
      url = location.href;
    this.busy = true;
    this.status.textContent = "正在分析… 可以继续阅读，翻译不会等待学习结果。";
    try {
      const data = await rpc("LEARN_AI", { kind, source: input, url });
      if (gen !== this.generation || url !== location.href) return;
      this.output.replaceChildren();
      this.status.textContent = "分析完成 · AI 内容可能有误，请对照原文。";
      if (kind === "recommend") {
        if (!data.items.length)
          this.output.append(element("p", "当前范围没有适合推荐的表达。"));
        for (const item of data.items) {
          const box = element("article");
          box.append(
            element("strong", item.text),
            element("p", item.translation),
            element("p", item.reason),
            this.button("加入学习", async () => {
              await rpc("LEARN_ADD", {
                url,
                record: {
                  ...item,
                  context: input.slice(
                    Math.max(
                      0,
                      input.toLowerCase().indexOf(item.text.toLowerCase()) -
                        200,
                    ),
                    Math.max(
                      0,
                      input.toLowerCase().indexOf(item.text.toLowerCase()) -
                        200,
                    ) + 1000,
                  ),
                },
              });
              box.replaceChildren(element("p", item.text + " · 已加入"));
            }),
          );
          this.output.append(box);
        }
      } else if (kind === "explain")
        this.output.append(
          element("p", data.explanation),
          element("blockquote", data.evidence),
        );
      else {
        let answered = 0,
          correct = 0;
        for (const q of data.questions) {
          const box = element("article");
          box.append(
            element(
              "strong",
              (q.kind === "comprehension" ? "文章理解 · " : "词汇表达 · ") +
                q.question,
            ),
          );
          for (const [i, o] of q.options.entries())
            box.append(
              this.button(o, () => {
                answered++;
                if (i === q.answer) correct++;
                box
                  .querySelectorAll("button")
                  .forEach((b) => (b.disabled = true));
                box.append(
                  element(
                    "p",
                    (i === q.answer
                      ? "答对了。"
                      : "参考答案：" + q.options[q.answer]) +
                      "\n" +
                      q.explanation,
                  ),
                  element("blockquote", q.evidence),
                );
                if (answered === data.questions.length)
                  this.output.append(
                    element(
                      "p",
                      `本次 ${correct}/${answered}。这只反映当前练习；若持续太难或太易，可在学习设置调整水平。`,
                    ),
                  );
              }),
            );
          this.output.append(box);
        }
      }
    } catch (e) {
      if (gen === this.generation) this.error(e);
    } finally {
      this.busy = false;
    }
  }
}
export async function startLearning(automatic = false) {
  if (!instance && !(await rpc("LEARN_GET")).preferences.enabled) return;
  if (!instance) instance = new LearningPage();
  const state = await instance.refresh();
  if (
    automatic &&
    state.preferences.enabled &&
    !instance.analyzed.has(location.href)
  ) {
    instance.analyzed.add(location.href);
    void instance.analyze("recommend").catch((e) => instance.error(e));
  }
  return instance;
}
