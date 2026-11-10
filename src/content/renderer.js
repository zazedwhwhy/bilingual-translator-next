export class Renderer {
  constructor() {
    this.nodes = new Map();
  }
  remove(id) {
    const node = this.nodes.get(id);
    if (node?.dataset.btNext === id) node.remove();
    this.nodes.delete(id);
  }
  show(record, text, lang, error = false) {
    this.remove(record.id);
    if (!record.element.isConnected) return;
    const node = record.element.ownerDocument.createElement("span");
    node.dataset.btNext = record.id;
    node.className = error ? "bt-next-result bt-next-error" : "bt-next-result";
    node.translate = false;
    node.lang = lang;
    node.textContent = text;
    record.element.append(node);
    this.nodes.set(record.id, node);
  }
  restore() {
    for (const id of [...this.nodes.keys()]) this.remove(id);
  }
}
