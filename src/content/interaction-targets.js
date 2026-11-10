import { fail, length } from "../shared/core.js";
const excluded =
  '[data-bt-next],script,style,noscript,pre,code,[hidden],[aria-hidden="true"],[translate="no"],.monaco-editor,.CodeMirror,.cm-editor,[data-lexical-editor],[data-slate-editor],.ProseMirror';
const fieldSelector = "input,textarea,[contenteditable]";
const elementOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
const signature = (element) =>
  element.matches("input,textarea") ? element.value : element.innerHTML;
const textOf = (element) =>
  element.matches("input,textarea")
    ? element.value
    : element.innerText.replace(/\r\n?/g, "\n");
function safeElement(element) {
  return (
    !!element?.isConnected &&
    !element.closest(excluded) &&
    element.getClientRects().length > 0
  );
}
export function editableTarget(node) {
  const element = elementOf(node)?.closest(fieldSelector);
  if (
    !safeElement(element) ||
    element.disabled ||
    element.readOnly ||
    element.closest('[aria-disabled="true"],[aria-readonly="true"],[inert]')
  )
    return null;
  if (element.matches("input") && !["text", "search"].includes(element.type))
    return null;
  if (!element.matches("input,textarea") && !element.isContentEditable)
    return null;
  const completion = (element.getAttribute("autocomplete") || "").toLowerCase();
  const description = ["name", "id", "aria-label", "placeholder"]
    .map((key) => element.getAttribute(key) || "")
    .join(" ");
  if (
    /(?:^|\s)(?:cc-[\w-]+|one-time-code|(?:current|new)-password|username)(?:\s|$)/i.test(
      completion,
    ) ||
    /password|passwd|api[\s_-]*key|secret|(?:credit|debit|payment)[\s_-]*card|card[\s_-]*(?:number|num|no)|cardholder|(?:verification|security)[\s_-]*code|one[\s_-]*time[\s_-]*(?:code|password)|(?:^|[\s_-])(?:otp|cvv|cvc|token)(?:$|[\s_-])|信用卡|验证码|密码|密钥/i.test(
      description,
    )
  )
    return null;
  return element;
}
export function inputSnapshot(node) {
  const target = editableTarget(node);
  if (!target)
    fail(
      "INPUT_UNSUPPORTED",
      "这个编辑区不支持安全替换。可选中文字后翻译并复制。",
    );
  const all = textOf(target),
    before = signature(target);
  let start = 0,
    end = all.length,
    range = null,
    text = all;
  const plain = target.matches("input,textarea");
  if (plain) {
    if (target.selectionEnd > target.selectionStart) {
      start = target.selectionStart;
      end = target.selectionEnd;
      text = all.slice(start, end);
    }
  } else {
    const selection = target.ownerDocument.getSelection();
    if (
      selection.rangeCount &&
      !selection.isCollapsed &&
      target.contains(selection.anchorNode) &&
      target.contains(selection.focusNode)
    ) {
      range = selection.getRangeAt(0).cloneRange();
      text = range.toString();
    } else {
      range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
    }
  }
  if (!text.trim()) fail("INPUT_EMPTY", "请先输入需要翻译的文字。");
  if (length(text) > 6000)
    fail(
      "INTERACTION_TOO_LONG",
      "一次最多翻译6000字符，请只选中需要翻译的部分。",
    );
  const fragment = !plain
    ? target.ownerDocument.createDocumentFragment()
    : null;
  if (fragment)
    for (const child of target.childNodes)
      fragment.append(child.cloneNode(true));
  let prefix = "",
    suffix = "";
  if (!plain) {
    const leading = target.ownerDocument.createRange(),
      trailing = target.ownerDocument.createRange();
    leading.selectNodeContents(target);
    leading.setEnd(range.startContainer, range.startOffset);
    trailing.selectNodeContents(target);
    trailing.setStart(range.endContainer, range.endOffset);
    prefix = leading.toString();
    suffix = trailing.toString();
  }
  return {
    target,
    text,
    all,
    before,
    plain,
    start,
    end,
    range,
    fragment,
    prefix,
    suffix,
    rect: target.getBoundingClientRect(),
  };
}
export function inputUnchanged(snapshot) {
  return (
    editableTarget(snapshot.target) === snapshot.target &&
    signature(snapshot.target) === snapshot.before
  );
}
function beforeInput(target, inputType, data) {
  const EventType = target.ownerDocument.defaultView.InputEvent;
  if (
    !target.dispatchEvent(
      new EventType("beforeinput", {
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType,
        data,
      }),
    )
  )
    fail("INPUT_REJECTED", "编辑器阻止了替换。可以复制译文后自行粘贴。");
}
function changed(target, inputType, data) {
  const EventType = target.ownerDocument.defaultView.InputEvent;
  target.dispatchEvent(
    new EventType("input", { bubbles: true, composed: true, inputType, data }),
  );
}
function setValue(target, value) {
  const win = target.ownerDocument.defaultView;
  const prototype =
    target.tagName === "TEXTAREA"
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
}
export function applyInput(snapshot, translation) {
  if (!inputUnchanged(snapshot))
    fail(
      "INPUT_CHANGED",
      "原文已修改或编辑区已改变，请重新翻译；当前输入未替换。",
    );
  if (typeof translation !== "string" || !translation.trim())
    fail("RESPONSE_FORMAT", "译文为空，未替换输入。");
  const { target } = snapshot;
  const value =
    snapshot.all.slice(0, snapshot.start) +
    translation +
    snapshot.all.slice(snapshot.end);
  if (
    snapshot.plain &&
    target.maxLength >= 0 &&
    value.length > target.maxLength
  )
    fail(
      "INPUT_TOO_LONG",
      "译文超过输入框长度限制，请复制后缩短；当前输入未替换。",
    );
  beforeInput(target, "insertReplacementText", translation);
  // A page can modify its field in beforeinput; never overwrite that change.
  if (!inputUnchanged(snapshot))
    fail("INPUT_CHANGED", "编辑区在替换前发生变化，请重新翻译。");
  target.focus({ preventScroll: true });
  if (snapshot.plain) {
    setValue(target, value);
    target.setSelectionRange(
      snapshot.start,
      snapshot.start + translation.length,
    );
    changed(target, "insertReplacementText", translation);
  } else {
    const selection = target.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(snapshot.range);
    let emitted = false;
    const observe = () => {
      emitted = true;
    };
    target.addEventListener("input", observe, { once: true });
    const accepted = target.ownerDocument.execCommand(
      "insertText",
      false,
      translation,
    );
    target.removeEventListener("input", observe);
    if (!accepted)
      fail("INPUT_REJECTED", "这个富文本编辑器不接受替换，请复制译文。");
    if (!emitted) changed(target, "insertReplacementText", translation);
  }
  const normalized = (value) => value.replace(/\s+/gu, " ").trim();
  if (
    editableTarget(target) !== target ||
    (snapshot.plain
      ? target.value !== value
      : normalized(textOf(target)) !==
        normalized(snapshot.prefix + translation + snapshot.suffix))
  )
    fail(
      "INPUT_REJECTED",
      "编辑器未保留预期译文，请检查当前内容或复制译文；未记录为成功替换。",
    );
  return { ...snapshot, after: signature(target) };
}
export function inputApplied(transaction) {
  return (
    editableTarget(transaction.target) === transaction.target &&
    signature(transaction.target) === transaction.after
  );
}
export function undoInput(transaction) {
  const { target } = transaction;
  if (
    editableTarget(target) !== target ||
    signature(target) !== transaction.after
  )
    fail("INPUT_CHANGED", "你已继续编辑，不能撤销到旧版本；当前内容未修改。");
  beforeInput(target, "historyUndo", null);
  if (signature(target) !== transaction.after)
    fail("INPUT_CHANGED", "编辑区在撤销前发生变化，未覆盖当前内容。");
  target.focus({ preventScroll: true });
  if (transaction.plain) {
    setValue(target, transaction.before);
    target.setSelectionRange(transaction.start, transaction.end);
  } else target.replaceChildren(transaction.fragment.cloneNode(true));
  changed(target, "historyUndo", null);
  if (signature(target) !== transaction.before)
    fail("INPUT_REJECTED", "编辑器未接受恢复原文，请检查当前输入内容。");
}
export function readSelection(doc = document) {
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0),
    start = elementOf(range.startContainer),
    end = elementOf(range.endContainer);
  if (
    !safeElement(start) ||
    !safeElement(end) ||
    start.closest(fieldSelector) ||
    end.closest(fieldSelector)
  )
    return null;
  if (range.cloneContents().querySelector(fieldSelector + "," + excluded))
    return null;
  const text = selection.toString().trim();
  if (!text) return null;
  return {
    text,
    range: range.cloneRange(),
    rect: range.getBoundingClientRect(),
    tooLong: length(text) > 6000,
  };
}
export function hoverTarget(x, y, doc = document) {
  const hit = doc.elementFromPoint(x, y);
  if (
    !safeElement(hit) ||
    hit.closest(
      fieldSelector + ',button,a,select,[role="button"],[role="menu"]',
    )
  )
    return null;
  let element = hit;
  while (
    element &&
    !element.matches("p,li,blockquote,h1,h2,h3,h4,h5,h6,td,th,figcaption")
  ) {
    if (
      element.parentElement?.matches("body,main,article,section") &&
      element.innerText?.trim()
    )
      break;
    element = element.parentElement;
  }
  if (!safeElement(element)) return null;
  const text = element.innerText.trim();
  if (!text || length(text) > 6000) return null;
  return { target: element, text, rect: element.getBoundingClientRect() };
}
