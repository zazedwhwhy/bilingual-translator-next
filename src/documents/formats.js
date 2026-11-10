import { unzipSync, zipSync, strToU8, strFromU8 } from "../vendor/zip.js";
import { fail } from "../shared/core.js";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const MAX_FILE = 64 * 1024 * 1024,
  MAX_EXPANDED = 256 * 1024 * 1024;
export function inspectZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE)
    fail("FILE_LIMIT", "文件超过64 MiB上限");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) fail("FILE_INVALID", "ZIP目录无效");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    count === 65535 ||
    offset === 0xffffffff ||
    size === 0xffffffff ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true)
  )
    fail("FILE_INVALID", "不支持ZIP64或分卷文件");
  if (count > 2000 || offset + size > end)
    fail("FILE_LIMIT", "压缩目录超过限制");
  let cursor = offset,
    total = 0;
  const rows = [],
    seen = new Set();
  for (let i = 0; i < count; i++) {
    if (
      cursor + 46 > offset + size ||
      view.getUint32(cursor, true) !== 0x02014b50
    )
      fail("FILE_INVALID", "ZIP目录损坏");
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      expanded = view.getUint32(cursor + 24, true),
      nameSize = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true);
    if (
      cursor + 46 + nameSize + extra + comment > offset + size ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      fail("FILE_INVALID", "加密或不支持的压缩格式");
    const name = new TextDecoder().decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameSize),
    );
    if (
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.split("/").includes("..") ||
      seen.has(name)
    )
      fail("FILE_INVALID", "压缩包路径无效");
    seen.add(name);
    total += expanded;
    if (expanded > MAX_FILE || total > MAX_EXPANDED)
      fail("FILE_LIMIT", "展开文件超过安全上限");
    rows.push({ name, size: expanded });
    cursor += 46 + nameSize + extra + comment;
  }
  if (cursor !== offset + size) fail("FILE_INVALID", "ZIP目录长度不一致");
  return rows;
}
function unpack(bytes) {
  inspectZip(bytes);
  try {
    return unzipSync(bytes);
  } catch {
    fail("FILE_INVALID", "压缩文件无法展开");
  }
}
function xml(text, mime = "application/xml") {
  if (mime === "text/html") {
    const doc = document.implementation.createHTMLDocument("");
    const template = doc.createElement("template");
    template.innerHTML = text;
    safeHTML(template.content);
    doc.body.append(template.content);
    return doc;
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    fail("FILE_INVALID", "不接受DTD或实体声明");
  const doc = new DOMParser().parseFromString(text, mime);
  if (doc.querySelector("parsererror")) fail("FILE_INVALID", "XML格式无效");
  return doc;
}
function elements(doc, ns, name) {
  return [...doc.getElementsByTagNameNS(ns, name)];
}
function fileXML(entries, path) {
  if (!entries[path]) fail("FILE_INVALID", "缺少文件：" + path);
  return xml(strFromU8(entries[path]));
}
function serialize(doc) {
  return strToU8(new XMLSerializer().serializeToString(doc));
}
function finishDocument(model) {
  if (!model.segments.length) fail("FILE_NO_TEXT", "文件没有可翻译文字");
  return model;
}
function fullTranslations(model, translations) {
  for (const s of model.segments)
    if (
      typeof translations.get(s.id) !== "string" ||
      !translations.get(s.id).trim()
    )
      fail("TRANSLATION_INCOMPLETE", "仍有未完成段落，暂不能导出完整文件");
}
function model(kind, name) {
  return { kind, name, segments: [], patches: [] };
}
function addSegment(doc, text, location, patch) {
  if (!/[\p{L}]/u.test(text)) return;
  const segment = { id: "s" + doc.segments.length, text, location };
  doc.segments.push(segment);
  if (patch) doc.patches.push({ ...patch, id: segment.id });
}
export function openTextDocument(name, source) {
  const kind = /\.md$/i.test(name) ? "md" : "txt";
  const doc = { ...model(kind, name), source, parts: [] };
  const lines = source.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  let fence = null,
    buffer = "";
  const flush = () => {
    if (!buffer) return;
    const index = doc.parts.length;
    doc.parts.push({ text: buffer });
    if (buffer.trim())
      addSegment(doc, buffer.trim(), "段落 " + (index + 1), { index });
    buffer = "";
  };
  for (const line of lines) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (kind === "md" && (fence || match)) {
      flush();
      doc.parts.push({ text: line });
      if (match) {
        if (!fence) fence = match[1][0];
        else if (match[1][0] === fence) fence = null;
      }
      continue;
    }
    if (!line.trim()) {
      flush();
      doc.parts.push({ text: line });
    } else buffer += line;
  }
  flush();
  return finishDocument(doc);
}
export function exportTextDocument(doc, translations) {
  fullTranslations(doc, translations);
  const patches = new Map(doc.patches.map((p) => [p.index, p.id]));
  return doc.parts
    .map((part, index) => {
      const id = patches.get(index);
      if (!id) return part.text;
      const t = translations.get(id);
      return (
        part.text.replace(/\n?$/, "") +
        "\n" +
        (doc.kind === "md"
          ? t
              .split("\n")
              .map((s) => "> " + s)
              .join("\n")
          : t) +
        "\n"
      );
    })
    .join("");
}
function ownTexts(paragraph, ns) {
  return elements(paragraph, ns, "t").filter((t) => {
    let p = t.parentElement;
    while (p && !(p.namespaceURI === ns && p.localName === "p"))
      p = p.parentElement;
    return p === paragraph;
  });
}
function safeHTML(doc) {
  for (const element of [
    ...doc.querySelectorAll(
      "script,style,iframe,frame,object,embed,link,meta,base,form,input,textarea,button,svg,math,template,video,audio,source,track",
    ),
  ])
    element.remove();
  for (const element of doc.querySelectorAll("*"))
    for (const attr of [...element.attributes])
      if (
        /^on/i.test(attr.name) ||
        [
          "src",
          "srcset",
          "href",
          "style",
          "action",
          "formaction",
          "xlink:href",
          "poster",
          "background",
          "data",
          "srcdoc",
          "ping",
        ].includes(attr.name.toLowerCase())
      )
        element.removeAttribute(attr.name);
}
function htmlBlocks(doc) {
  const tags =
    "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,div,section";
  return [...doc.querySelectorAll(tags)].filter(
    (e) =>
      !e.closest("script,style,code,pre,nav") &&
      !e.querySelector(tags) &&
      /[\p{L}]/u.test(e.textContent),
  );
}
function archivePath(base, href) {
  let url;
  try {
    url = new URL(href, "https://book.invalid/" + base);
  } catch {
    fail("FILE_INVALID", "书籍路径无效");
  }
  if (url.origin !== "https://book.invalid")
    fail("FILE_INVALID", "不支持远程书籍章节");
  return decodeURIComponent(url.pathname.slice(1));
}
function getEpubSpine(entries) {
  if (entries["META-INF/encryption.xml"])
    fail("FILE_ENCRYPTED", "不支持带加密或DRM声明的电子书");
  const container = fileXML(entries, "META-INF/container.xml"),
    root = elements(container, "*", "rootfile")[0]?.getAttribute("full-path");
  if (!root) fail("FILE_INVALID", "EPUB缺少根文档");
  const opf = fileXML(entries, root),
    items = new Map(
      elements(opf, "*", "item").map((e) => [
        e.getAttribute("id"),
        e.getAttribute("href"),
      ]),
    );
  const paths = elements(opf, "*", "itemref")
    .filter((e) => e.getAttribute("linear") !== "no")
    .map((e) => {
      const href = items.get(e.getAttribute("idref"));
      if (!href?.trim())
        fail("FILE_INVALID", "EPUB阅读顺序引用了不存在或空白的资源");
      return archivePath(root, href);
    });
  if (!paths.length) fail("FILE_INVALID", "EPUB没有阅读顺序");
  return paths;
}
function relationships(entries, base) {
  const slash = base.lastIndexOf("/"),
    path =
      base.slice(0, slash + 1) + "_rels/" + base.slice(slash + 1) + ".rels";
  return elements(fileXML(entries, path), "*", "Relationship");
}
export function openXMLDocument(name, bytes) {
  const kind = name.toLowerCase().split(".").pop();
  if (!["epub", "docx", "pptx", "xlsx", "html", "htm"].includes(kind))
    fail("FILE_UNSUPPORTED", "不支持该文件格式");
  if (kind === "html" || kind === "htm") {
    const parsed = xml(new TextDecoder().decode(bytes), "text/html");
    safeHTML(parsed);
    const result = { ...model("html", name), html: parsed };
    htmlBlocks(parsed).forEach((e, index) =>
      addSegment(result, e.textContent.trim(), "段落 " + (index + 1), {
        path: "html",
        index,
      }),
    );
    return finishDocument(result);
  }
  const entries = unpack(bytes),
    result = { ...model(kind, name), entries };
  let paths = [];
  if (kind === "epub") paths = getEpubSpine(entries);
  if (kind === "docx") {
    if (!entries["word/document.xml"]) fail("FILE_INVALID", "无效DOCX");
    paths = Object.keys(entries).filter((p) =>
      /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p),
    );
  }
  if (kind === "pptx") {
    if (!entries["ppt/presentation.xml"]) fail("FILE_INVALID", "无效PPTX");
    const presentation = fileXML(entries, "ppt/presentation.xml"),
      rels = new Map(
        relationships(entries, "ppt/presentation.xml").map((e) => [
          e.getAttribute("Id"),
          e,
        ]),
      );
    for (const slide of elements(presentation, "*", "sldId")) {
      const id = slide.getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "id",
        ),
        relation = rels.get(id);
      if (!relation || relation.getAttribute("TargetMode") === "External")
        fail("FILE_INVALID", "幻灯片关系无效");
      const path = archivePath(
        "ppt/presentation.xml",
        relation.getAttribute("Target"),
      );
      paths.push(path);
      const slash = path.lastIndexOf("/"),
        relationPath =
          path.slice(0, slash + 1) + "_rels/" + path.slice(slash + 1) + ".rels";
      if (entries[relationPath])
        for (const note of relationships(entries, path).filter((e) =>
          e.getAttribute("Type").endsWith("/notesSlide"),
        )) {
          if (note.getAttribute("TargetMode") === "External")
            fail("FILE_INVALID", "不支持远程备注");
          paths.push(archivePath(path, note.getAttribute("Target")));
        }
    }
  }
  if (kind === "xlsx") {
    if (!entries["xl/workbook.xml"]) fail("FILE_INVALID", "无效XLSX");
    paths = Object.keys(entries).filter((p) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(p),
    );
    const used = new Map();
    for (const path of paths) {
      const sheet = fileXML(entries, path);
      for (const cell of elements(sheet, X, "c")) {
        if (elements(cell, X, "f").length) continue;
        const label = path + "!" + cell.getAttribute("r");
        if (cell.getAttribute("t") === "s") {
          const value = Number(elements(cell, X, "v")[0]?.textContent);
          if (!Number.isInteger(value) || value < 0)
            fail("FILE_INVALID", "共享字符串索引无效");
          if (!used.has(value)) used.set(value, []);
          used.get(value).push(label);
        } else if (cell.getAttribute("t") === "inlineStr") {
          const is = elements(cell, X, "is")[0];
          if (is)
            addSegment(
              result,
              elements(is, X, "t")
                .map((t) => t.textContent)
                .join(""),
              label,
              { path, index: elements(sheet, X, "is").indexOf(is), type: "is" },
            );
        }
      }
    }
    if (used.size) {
      const shared = fileXML(entries, "xl/sharedStrings.xml"),
        strings = elements(shared, X, "si");
      for (const [index, locations] of used) {
        const item = strings[index];
        if (!item) fail("FILE_INVALID", "共享字符串缺失");
        addSegment(
          result,
          elements(item, X, "t")
            .filter((t) => !t.parentElement.closest("rPh"))
            .map((t) => t.textContent)
            .join(""),
          locations.join(", "),
          { path: "xl/sharedStrings.xml", index, type: "si" },
        );
      }
    }
    return finishDocument(result);
  }
  for (const path of paths) {
    const parsed = fileXML(entries, path);
    if (kind === "epub") {
      htmlBlocks(parsed).forEach((e, index) =>
        addSegment(result, e.textContent.trim(), path + " · " + (index + 1), {
          path,
          index,
          type: "html",
        }),
      );
    } else {
      const ns = kind === "docx" ? W : A;
      elements(parsed, ns, "p").forEach((p, index) => {
        const text = ownTexts(p, ns)
          .map((t) => t.textContent)
          .join("");
        addSegment(result, text, path + " · " + (index + 1), {
          path,
          index,
          type: "paragraph",
          ns,
        });
      });
    }
  }
  return finishDocument(result);
}
export function exportXMLDocument(doc, translations) {
  fullTranslations(doc, translations);
  const entries = doc.entries ? { ...doc.entries } : null,
    documents = new Map();
  for (const patch of doc.patches) {
    let parsed = documents.get(patch.path);
    if (!parsed) {
      parsed =
        patch.path === "html"
          ? doc.html.cloneNode(true)
          : fileXML(entries, patch.path);
      documents.set(patch.path, parsed);
    }
    const text = translations.get(patch.id);
    if (patch.type === "html" || patch.path === "html") {
      const node = htmlBlocks(parsed)[patch.index];
      if (!node) fail("EXPORT_FAILED", "章节段落位置丢失");
      const translated = parsed.createElementNS(node.namespaceURI, "span");
      translated.setAttribute("data-bt-next-export", "translation");
      translated.setAttribute(
        "style",
        "display:block;white-space:pre-wrap;margin:0.5em 0",
      );
      translated.textContent = text;
      node.appendChild(translated);
    } else if (patch.type === "paragraph") {
      const p = elements(parsed, patch.ns, "p")[patch.index];
      const run = parsed.createElementNS(
          patch.ns,
          patch.ns === W ? "w:r" : "a:r",
        ),
        t = parsed.createElementNS(patch.ns, patch.ns === W ? "w:t" : "a:t"),
        br = parsed.createElementNS(patch.ns, patch.ns === W ? "w:br" : "a:br");
      const original = elements(p, patch.ns, "r")[0]?.getElementsByTagNameNS(
        patch.ns,
        "rPr",
      )[0];
      if (original) run.appendChild(original.cloneNode(true));
      t.textContent = text;
      t.setAttributeNS(
        "http://www.w3.org/XML/1998/namespace",
        "xml:space",
        "preserve",
      );
      if (patch.ns === W) run.appendChild(br);
      else p.appendChild(br);
      run.appendChild(t);
      const end = elements(p, patch.ns, "endParaRPr")[0];
      p.insertBefore(run, end || null);
    } else {
      const cell = elements(parsed, X, patch.type)[patch.index],
        texts = elements(cell, X, "t"),
        last = texts.at(-1);
      if (!last) fail("EXPORT_FAILED", "字符串位置丢失");
      if (
        texts.map((t) => t.textContent).join("").length + text.length + 1 >
        32767
      )
        fail("EXPORT_LIMIT", "单元格双语文字超过Excel上限");
      last.textContent += "\n" + text;
      last.setAttributeNS(
        "http://www.w3.org/XML/1998/namespace",
        "xml:space",
        "preserve",
      );
    }
  }
  if (doc.kind === "html")
    return new TextEncoder().encode(
      "<!doctype html>\n" +
        new XMLSerializer().serializeToString(documents.get("html")),
    );
  for (const [path, parsed] of documents) entries[path] = serialize(parsed);
  if (doc.kind === "epub") {
    const ordered = {
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    };
    for (const [path, value] of Object.entries(entries))
      if (path !== "mimetype") ordered[path] = value;
    return zipSync(ordered, { level: 6 });
  }
  return zipSync(entries, { level: 6 });
}
export function bilingualHTML(doc, translations) {
  fullTranslations(doc, translations);
  const esc = (t) =>
    t.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  return (
    '<!doctype html><meta charset="utf-8"><title>' +
    esc(doc.name) +
    "</title><style>body{max-width:900px;margin:32px auto;font:18px/1.6 system-ui}section{margin:24px 0}p{white-space:pre-wrap}.translation{border-left:3px solid #56877b;padding-left:16px}</style>" +
    doc.segments
      .map(
        (s) =>
          "<section><small>" +
          esc(s.location) +
          "</small><p>" +
          esc(s.text) +
          '</p><p class="translation">' +
          esc(translations.get(s.id)) +
          "</p></section>",
      )
      .join("")
  );
}
