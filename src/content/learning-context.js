import { textOf } from "./extractor.js";
const excluded =
  'input,textarea,select,[contenteditable],form,nav,header,footer,aside,script,style,[data-bt-next],[aria-hidden="true"],[hidden]';
export function allowed(el) {
  return (
    el instanceof Element &&
    !el.closest(excluded) &&
    !el.querySelector("input,textarea,[contenteditable],form") &&
    el.getClientRects().length &&
    getComputedStyle(el).visibility === "visible"
  );
}
export function nearbyContext(source) {
  const node = source.range?.commonAncestorContainer;
  const el =
    source.target || (node?.nodeType === 1 ? node : node?.parentElement);
  const block = el?.closest("p,li,blockquote,article") || el;
  if (!allowed(block)) return "";
  return textOf(block).slice(0, 2000);
}
export function articleText() {
  const root =
    document.querySelector('article,main,[role="main"]') || document.body;
  return [...root.querySelectorAll("p,h1,h2,h3,li,blockquote")]
    .filter(allowed)
    .filter((el) => !el.querySelector("p,li,blockquote"))
    .map((el) => textOf(el))
    .filter(Boolean)
    .join("\n")
    .slice(0, 18000);
}
