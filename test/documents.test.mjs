import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  inspectZip,
  openTextDocument,
  exportTextDocument,
} from "../src/documents/formats.js";
test("ZIP inspection rejects traversal, encryption, ZIP64 and expansion bombs", () => {
  assert.throws(() => inspectZip(zipSync({ "../evil.xml": strToU8("bad") })), {
    code: "FILE_INVALID",
  });
  const z = zipSync({ "word/document.xml": strToU8("hello") });
  const central = z.findIndex(
    (v, i) =>
      v === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 1 && z[i + 3] === 2,
  );
  const encrypted = z.slice();
  encrypted[central + 8] |= 1;
  assert.throws(() => inspectZip(encrypted), { code: "FILE_INVALID" });
  const huge = z.slice();
  new DataView(huge.buffer).setUint32(central + 24, 70 * 1024 * 1024, true);
  assert.throws(() => inspectZip(huge), { code: "FILE_LIMIT" });
  assert.equal(inspectZip(z).length, 1);
});
test("text export is bilingual and source remains intact", () => {
  const source = "First paragraph.\n\nSecond paragraph.";
  const doc = openTextDocument("note.txt", source);
  assert.equal(doc.segments.length, 2);
  const map = new Map(doc.segments.map((s, i) => [s.id, "译文" + i]));
  assert.ok(exportTextDocument(doc, map).includes("First paragraph.\n译文0"));
  assert.equal(doc.source, source);
  assert.throws(() => exportTextDocument(doc, new Map()), {
    code: "TRANSLATION_INCOMPLETE",
  });
});
test("Markdown skips fenced code while preserving original source on export", () => {
  const source =
    "# Heading\n\n```js\nconst privateValue=1;\n\nconsole.log(privateValue);\n```\n\nMore words.";
  const doc = openTextDocument("note.md", source);
  assert.equal(
    doc.segments.some((s) => s.text.includes("privateValue")),
    false,
  );
  const out = exportTextDocument(
    doc,
    new Map(doc.segments.map((s) => [s.id, "翻译"])),
  );
  assert.ok(out.includes("const privateValue=1;"));
  assert.equal(doc.source, source);
});
