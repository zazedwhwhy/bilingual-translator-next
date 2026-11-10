const css = `
:host{all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;color-scheme:light dark}
*{box-sizing:border-box} .surface{position:fixed;color:#20372f;background:#fff;font:15px/1.55 system-ui,sans-serif;text-align:start;letter-spacing:normal;box-shadow:0 8px 28px #142d2229;border-radius:12px;max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain}
.panel{width:410px;max-width:calc(100vw - 24px);padding:18px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}h2{font:600 16px/1.4 system-ui,sans-serif;margin:0}p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.status,details,.note{font-size:13px;color:#52665b}.error{color:#9b3027}.result{font-size:16px;line-height:1.65;margin:14px 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}button{font:500 14px/1.4 system-ui,sans-serif;min-height:40px;padding:9px 12px;border:1px solid #879e90;border-radius:7px;background:#fff;color:#20372f;cursor:pointer}button.primary{background:#315f4c;color:#fff;border-color:#315f4c}button:disabled{opacity:.55;cursor:default}button:hover:not(:disabled){background:#e8f0eb;color:#20372f}button:focus-visible,summary:focus-visible{outline:3px solid #527d68;outline-offset:3px}::selection{background:#c3dfcf;color:#142d22}summary{cursor:pointer}details p{max-height:130px;overflow:auto}.launch{max-width:calc(100vw - 24px);white-space:nowrap}.note{margin-top:12px} [hidden]{display:none!important}
@media(prefers-color-scheme:dark){.surface,button{background:#24352b;color:#e4ece7}button{border-color:#789985}.status,details,.note{color:#b5c9bc}.error{color:#ffb3a8}button:hover:not(:disabled){background:#385642;color:#fff}button.primary{background:#a9d6bb;color:#142d22;border-color:#a9d6bb}}
`;
const names = {
  selection: "划词翻译",
  hover: "悬停翻译",
  input: "输入框翻译",
  setup: "随手翻译",
};
export class InteractionView {
  constructor(doc = document) {
    this.doc = doc;
    this.host = doc.createElement("div");
    this.host.setAttribute("data-bt-next", "interaction");
    this.host.setAttribute("data-bt-interactions", "");
    this.shadow = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = css;
    this.root = doc.createElement("div");
    this.shadow.append(style, this.root);
    doc.documentElement.append(this.host);
  }
  owns(event) {
    return event.composedPath().includes(this.host);
  }
  button(label, action, primary = false) {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      if (event.isTrusted) action();
    });
    return button;
  }
  position(surface, rect) {
    const win = this.doc.defaultView,
      bounds = surface.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(rect.left, win.innerWidth - bounds.width - 12),
    );
    const below = rect.bottom + 8;
    const top =
      below + bounds.height <= win.innerHeight - 12
        ? below
        : Math.max(
            12,
            Math.min(
              rect.top - bounds.height - 8,
              win.innerHeight - bounds.height - 12,
            ),
          );
    surface.style.left = left + "px";
    surface.style.top = top + "px";
  }
  launch(mode, rect, action) {
    this.close();
    const button = this.button(
      mode === "input" ? "翻译输入内容" : "翻译选中内容",
      action,
    );
    button.classList.add("surface", "launch");
    this.root.append(button);
    this.position(button, rect);
  }
  show(state) {
    const focused = this.shadow.activeElement?.textContent;
    this.close();
    this.state = state;
    const panel = this.doc.createElement("section");
    panel.className = "surface panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", names[state.mode]);
    const header = this.doc.createElement("header"),
      heading = this.doc.createElement("h2");
    heading.textContent = names[state.mode];
    header.append(heading, this.button("关闭", state.onClose));
    panel.append(header);
    const status = this.doc.createElement("p");
    status.className = "status" + (state.error ? " error" : "");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = state.error || state.status || "正在翻译…";
    panel.append(status);
    const result = this.doc.createElement("p");
    result.className = "result";
    result.setAttribute("data-result", "");
    result.textContent = state.translation || "";
    result.hidden = !state.translation;
    panel.append(result);
    const source = this.doc.createElement("details"),
      summary = this.doc.createElement("summary"),
      original = this.doc.createElement("p");
    summary.textContent = "查看原文";
    original.textContent = state.source;
    source.append(summary, original);
    if (state.source) panel.append(source);
    const actions = this.doc.createElement("div");
    actions.className = "actions";
    if (state.onApply)
      actions.append(this.button("替换输入内容", state.onApply, true));
    if (state.onUndo) actions.append(this.button("撤销替换", state.onUndo));
    if (state.translation)
      actions.append(
        this.button("复制译文", () => {
          void (async () => {
            try {
              const clipboard = this.doc.defaultView.navigator.clipboard;
              if (!clipboard?.writeText) throw Error("clipboard unavailable");
              await clipboard.writeText(state.translation);
              status.textContent = "译文已复制。";
            } catch {
              status.textContent = "无法自动复制，请选中译文后复制。";
            }
          })();
        }),
      );
    if (state.onRetry)
      actions.append(
        this.button(state.retryLabel || "重新翻译", state.onRetry),
      );
    if (state.onContinue)
      actions.append(this.button("继续下一轮并翻译", state.onContinue));
    panel.append(actions);
    const note = this.doc.createElement("p");
    note.className = "note";
    note.textContent =
      state.mode === "input"
        ? "确认前不会修改输入。替换会通知原网页，扩展不执行发送；富文本选定区域将替换为纯文本。"
        : "仅把这段文字发送给你配置的翻译服务。";
    panel.append(note);
    this.root.append(panel);
    this.position(panel, state.rect);
    if (focused)
      [...panel.querySelectorAll("button")]
        .find((button) => button.textContent === focused)
        ?.focus({ preventScroll: true });
  }
  close() {
    this.root.replaceChildren();
    this.state = null;
  }
}
