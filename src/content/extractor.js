const candidates =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,div,section";
const excluded =
  'nav,header,footer,aside,script,style,noscript,template,pre,code,kbd,samp,input,textarea,select,button,svg,canvas,video,audio,[aria-hidden="true"],[data-bt-next]';
function editable(element) {
  for (let e = element; e; e = e.parentElement) {
    const attr = e.getAttribute("contenteditable");
    if (attr !== null) return attr !== "false";
  }
  return false;
}
function hidden(element) {
  for (let e = element; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden") return true;
  }
  return !element.getClientRects().length;
}
export function textOf(element) {
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  );
  const pieces = [];
  for (let n; (n = walker.nextNode()); ) {
    const p = n.parentElement;
    if (p && !p.closest(excluded) && !editable(p) && !hidden(p))
      pieces.push(n.textContent);
  }
  return pieces.join("").replace(/\r\n?/g, "\n").trim();
}
export class Extractor {
  constructor(doc = document) {
    this.doc = doc;
    this.records = new WeakMap();
    this.counter = 0;
  }
  scan() {
    const roots = [...this.doc.querySelectorAll('main,article,[role="main"]')];
    if (!roots.length) roots.push(this.doc.body);
    const elements = new Set(
      roots.flatMap((root) => [
        ...(root.matches(candidates) ? [root] : []),
        ...root.querySelectorAll(candidates),
      ]),
    );
    const eligible = [...elements].filter(
      (e) => !e.closest(excluded) && !editable(e) && !hidden(e),
    );
    const accepted = new Set(eligible);
    const out = [];
    for (const e of eligible) {
      if (
        [...e.querySelectorAll(candidates)].some((child) => accepted.has(child))
      )
        continue;
      const text = textOf(e);
      if (!/[\p{L}]/u.test(text)) continue;
      let r = this.records.get(e);
      if (!r) {
        r = { element: e, id: "p" + ++this.counter, revision: 0, text };
        this.records.set(e, r);
      } else if (r.text !== text) {
        r.text = text;
        r.revision++;
      }
      out.push(r);
    }
    return out;
  }
  current(record) {
    return record.element.isConnected && textOf(record.element) === record.text;
  }
}
