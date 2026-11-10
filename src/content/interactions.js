import { nearbyContext } from "./learning-context.js";
import { InteractionView } from "./interaction-view.js";
import {
  readSelection,
  hoverTarget,
  editableTarget,
  inputSnapshot,
  inputUnchanged,
  inputApplied,
  applyInput,
  undoInput,
} from "./interaction-targets.js";
const sameRange = (a, b) =>
  a.startContainer === b.startContainer &&
  a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer &&
  a.endOffset === b.endOffset;
class Interactions {
  constructor() {
    this.view = new InteractionView();
    this.preferences = {};
    this.generation = 0;
    this.pointer = { x: 0, y: 0 };
    this.alt = false;
    this.composing = false;
    this.url = location.href;
    const on = (target, type, callback, options) =>
      target.addEventListener(type, callback, options);
    on(document, "selectionchange", () => this.selection());
    on(document, "pointerup", (event) => {
      if (!this.view.owns(event)) this.selection();
    });
    on(
      document,
      "pointerdown",
      (event) => {
        if (!this.view.owns(event)) {
          const sameInput =
            this.active?.mode === "input" &&
            editableTarget(event.target) === this.active.source.target;
          if (!sameInput) this.close();
        }
      },
      true,
    );
    on(document, "pointermove", (event) => {
      if (event.isTrusted && !this.view.owns(event)) {
        this.pointer = { x: event.clientX, y: event.clientY };
        this.alt =
          event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
        this.hover();
      }
    });
    on(document, "keydown", (event) => this.keydown(event), true);
    on(document, "keyup", (event) => {
      if (event.key === "Alt") {
        this.alt = false;
        this.clearHover();
      }
    });
    on(document, "focusin", (event) => {
      if (!this.view.owns(event)) this.focus(event.target);
    });
    on(document, "input", (event) => this.edited(event), true);
    on(
      document,
      "compositionstart",
      () => {
        this.composing = true;
        this.close();
      },
      true,
    );
    on(
      document,
      "compositionend",
      () => {
        this.composing = false;
        this.focus(document.activeElement);
      },
      true,
    );
    on(
      document,
      "scroll",
      (event) => {
        if (!this.view.owns(event)) this.close();
      },
      true,
    );
    on(window, "blur", () => this.close());
    on(document, "visibilitychange", () => {
      if (document.hidden) this.close();
    });
    on(window, "pagehide", () => {
      this.close();
      clearInterval(this.routeTimer);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.englishLearningV1)
        this.preferences.learningEnabled =
          changes.englishLearningV1.newValue?.preferences?.enabled === true;
    });
    this.routeTimer = setInterval(() => {
      if (this.url !== location.href) {
        this.url = location.href;
        this.close();
      }
    }, 500);
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (
        sender.id === chrome.runtime.id &&
        message.channel === "BT_INTERACTION" &&
        message.type === "CONFIG_CHANGED"
      )
        void this.refresh();
    });
  }
  async send(type, data = {}) {
    let timer;
    try {
      const reply = await Promise.race([
        chrome.runtime.sendMessage({ channel: "BT_BG", type, ...data }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  Error("连接中断，处理结果未知，请手动重新翻译。"),
                  { code: "OUTCOME_UNKNOWN" },
                ),
              ),
            30000,
          );
        }),
      ]);
      if (!reply?.ok)
        throw Object.assign(
          Error(reply?.error?.message || "扩展连接已中断，请重新加载网页。"),
          reply?.error,
        );
      return reply.data;
    } finally {
      clearTimeout(timer);
    }
  }
  async refresh() {
    this.close();
    const version = ++this.generation;
    try {
      const config = await this.send("INTERACTION_READY");
      if (version === this.generation)
        this.preferences = config.ready ? config : {};
    } catch (error) {
      if (version !== this.generation) return;
      this.preferences = {};
      this.view.show({
        mode: "setup",
        source: "",
        rect: { left: 12, top: 12, bottom: 12 },
        error:
          "随手翻译未就绪：" + (error.message || "无法连接扩展，请检查设置。"),
        onClose: () => this.close(),
        onRetry: () => void this.refresh(),
        retryLabel: "重新连接",
      });
    }
  }
  cancel() {
    const request = this.active;
    this.active = null;
    if (request?.pending)
      void this.send("INTERACTION_CANCEL", { requestId: request.id }).catch(
        () => {},
      );
  }
  close() {
    this.clearHover();
    clearTimeout(this.selectionTimer);
    this.cancel();
    this.view.close();
    this.transaction = null;
  }
  selection() {
    clearTimeout(this.selectionTimer);
    if (!this.preferences.selection || this.composing) return;
    const selection = document.getSelection();
    if (selection?.anchorNode?.getRootNode() === this.view.shadow) return;
    if (
      this.active &&
      this.active.mode !== "input" &&
      selection?.rangeCount &&
      !selection.isCollapsed
    ) {
      const changed =
        this.active.mode !== "selection" ||
        !sameRange(this.active.source.range, selection.getRangeAt(0)) ||
        selection.toString().trim() !== this.active.source.text;
      if (changed) this.close();
    }
    this.selectionTimer = setTimeout(() => {
      if (this.active?.mode === "input") return;
      const source = readSelection();
      if (!source) {
        if (!this.active) this.view.close();
        return;
      }
      if (
        this.active?.mode === "selection" &&
        this.active.source.text === source.text &&
        sameRange(this.active.source.range, source.range)
      )
        return;
      this.cancel();
      this.view.launch("selection", source.rect, () => {
        const current = readSelection();
        if (!current || current.text !== source.text) {
          this.close();
          return;
        }
        void this.translate("selection", current);
      });
    }, 100);
  }
  focus(target) {
    this.clearHover();
    const field = editableTarget(target);
    if (
      (this.active?.mode === "input" && field !== this.active.source.target) ||
      (this.active?.mode === "hover" &&
        (target.matches?.("input,textarea,select") || target.isContentEditable))
    )
      this.close();
    if (
      !this.preferences.input ||
      this.composing ||
      this.active?.mode === "input"
    )
      return;
    if (!field) return;
    this.cancel();
    this.view.launch("input", field.getBoundingClientRect(), () =>
      this.input(field),
    );
  }
  input(target) {
    if (this.composing) return;
    this.clearHover();
    this.cancel();
    this.transaction = null;
    try {
      void this.translate("input", inputSnapshot(target));
    } catch (error) {
      this.view.show({
        mode: "input",
        source: "",
        rect: target.getBoundingClientRect(),
        error: error.message,
        onClose: () => this.close(),
      });
    }
  }
  keydown(event) {
    if (!event.isTrusted) return;
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (event.isComposing || this.composing) return;
    if (
      this.preferences.input &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "t" &&
      editableTarget(event.target)
    ) {
      event.preventDefault();
      this.input(event.target);
      return;
    }
    if (
      event.key === "Alt" &&
      this.preferences.hover &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      this.alt = true;
      this.hover();
    } else {
      this.alt = false;
      this.clearHover();
    }
  }
  clearHover() {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverCandidate = null;
  }
  hoverAllowed() {
    const focused = document.activeElement;
    return (
      this.preferences.hover &&
      this.alt &&
      !this.composing &&
      !focused?.matches("input,textarea,select") &&
      !focused?.isContentEditable &&
      !readSelection()
    );
  }
  hover() {
    if (!this.hoverAllowed()) {
      this.clearHover();
      return;
    }
    const source = hoverTarget(this.pointer.x, this.pointer.y);
    if (!source) {
      this.clearHover();
      if (this.active?.mode === "hover") this.close();
      return;
    }
    if (
      this.active?.mode === "hover" &&
      this.active.source.target === source.target &&
      this.active.source.text === source.text
    ) {
      this.clearHover();
      return;
    }
    if (
      this.hoverCandidate?.target === source.target &&
      this.hoverCandidate.text === source.text &&
      this.hoverTimer !== null
    )
      return;
    this.clearHover();
    if (this.active?.mode === "hover") {
      this.cancel();
      this.view.close();
    }
    this.hoverCandidate = source;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.hoverCandidate = null;
      if (!this.hoverAllowed()) return;
      const current = hoverTarget(this.pointer.x, this.pointer.y);
      if (current?.target !== source.target || current.text !== source.text)
        return;
      void this.translate("hover", current);
    }, 450);
  }
  valid(request) {
    if (
      this.active !== request ||
      request.url !== location.href ||
      !this.preferences[request.mode]
    )
      return false;
    if (request.mode === "input") return inputUnchanged(request.source);
    if (request.mode === "hover")
      return (
        request.source.target.isConnected &&
        request.source.target.innerText.trim() === request.source.text
      );
    return (
      request.source.range.startContainer.isConnected &&
      request.source.range.toString().trim() === request.source.text
    );
  }
  display(request, data = {}) {
    this.view.show({
      mode: request.mode,
      source: request.source.text,
      rect: request.source.rect,
      onClose: () => this.close(),
      ...data,
    });
  }
  async translate(mode, source) {
    this.cancel();
    this.transaction = null;
    const request = {
      id: crypto.randomUUID(),
      mode,
      source,
      url: location.href,
      pending: true,
    };
    this.active = request;
    this.display(request, {
      status:
        mode === "input"
          ? "正在翻译成 " + this.preferences.inputTarget + "，请先不要修改原文…"
          : "正在翻译…",
    });
    try {
      const result = await this.send("INTERACTION_TRANSLATE", {
        requestId: request.id,
        mode,
        text: source.text,
        context:
          mode === "input" || !this.preferences.learningEnabled
            ? ""
            : nearbyContext(source),
        url: request.url,
      });
      if (!this.valid(request)) {
        if (this.active === request) this.stale(request);
        return;
      }
      request.pending = false;
      request.result = result;
      this.display(request, {
        translation: result.translation,
        status:
          (result.cached
            ? "已读取缓存 · " + result.target
            : "翻译完成 · " + result.target) +
          (result.learningWarning ? "\n" + result.learningWarning : "") +
          (result.cacheDegraded
            ? "\n检测到缓存读写异常，重复翻译可能再次请求。"
            : ""),
        ...(mode === "input" ? { onApply: () => this.apply(request) } : {}),
      });
    } catch (error) {
      if (this.active !== request) return;
      request.pending = false;
      if (error.code === "CANCELLED") {
        this.close();
        return;
      }
      this.display(request, {
        error: (error.code || "ERROR") + "：" + error.message,
        ...(error.code === "BUDGET_EXCEEDED"
          ? { onContinue: () => void this.continue(request) }
          : { onRetry: () => this.retry(request) }),
      });
      if (error.code === "OUTCOME_UNKNOWN")
        void this.send("INTERACTION_CANCEL", { requestId: request.id }).catch(
          () => {},
        );
    }
  }
  retry(request) {
    if (request.mode === "input") this.input(request.source.target);
    else if (this.valid(request))
      void this.translate(request.mode, request.source);
    else this.stale(request);
  }
  async continue(request) {
    try {
      await this.send("INTERACTION_CONTINUE");
      this.retry(request);
    } catch (error) {
      if (this.active === request)
        this.display(request, { error: error.message });
    }
  }
  stale(request) {
    this.cancel();
    this.display(request, { error: "原文或页面已改变，请重新选择并翻译。" });
  }
  edited(event) {
    if (this.writing || this.view.owns(event)) return;
    if (
      this.active?.mode === "input" &&
      this.active.source.target.contains(event.target)
    )
      this.stale(this.active);
  }
  async apply(request) {
    if (request.applying) return;
    if (!this.valid(request)) {
      this.stale(request);
      return;
    }
    request.applying = true;
    try {
      this.display(request, {
        translation: request.result.translation,
        status: "正在核对编辑区…",
      });
      await this.send("INTERACTION_VALIDATE", {
        configRevision: request.result.configRevision,
        target: request.result.target,
        url: request.url,
      });
      if (!this.valid(request)) {
        if (this.active === request) this.stale(request);
        return;
      }
      this.writing = true;
      this.transaction = applyInput(request.source, request.result.translation);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (this.active !== request) return;
      if (!inputApplied(this.transaction))
        throw Object.assign(
          Error("原网页未保留译文，请检查输入内容或复制译文。"),
          { code: "INPUT_REJECTED" },
        );
      this.display(request, {
        translation: request.result.translation,
        status: "已替换输入内容，扩展未执行发送。",
        onUndo: () => this.undo(request),
      });
    } catch (error) {
      if (this.active === request)
        this.display(request, {
          translation: request.result.translation,
          error: error.message,
        });
    } finally {
      this.writing = false;
      request.applying = false;
    }
  }
  undo(request) {
    try {
      this.writing = true;
      undoInput(this.transaction);
      this.transaction = null;
      this.display(request, {
        translation: request.result.translation,
        status: "已恢复原输入内容。",
      });
    } catch (error) {
      this.display(request, {
        translation: request.result.translation,
        error: error.message,
      });
    } finally {
      this.writing = false;
    }
  }
}
export function mountInteractions() {
  return new Interactions();
}
