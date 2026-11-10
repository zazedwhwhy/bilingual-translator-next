import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "src/vendor");
await fs.mkdir(vendor, { recursive: true });
await build({
  stdin: {
    contents: "export {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';",
    resolveDir: root,
  },
  bundle: true,
  format: "esm",
  outfile: path.join(vendor, "zip.js"),
  minify: true,
  legalComments: "eof",
});
await build({
  stdin: {
    contents:
      "export {PDFDocument,PDFName,rgb} from 'pdf-lib';export {default as fontkit} from '@pdf-lib/fontkit';",
    resolveDir: root,
  },
  bundle: true,
  format: "esm",
  outfile: path.join(vendor, "pdf-export.js"),
  minify: true,
  legalComments: "eof",
});
for (const name of ["pdf.mjs", "pdf.worker.mjs"])
  await fs.copyFile(
    path.join(root, "node_modules/pdfjs-dist/build", name),
    path.join(vendor, name),
  );
for (const dir of ["cmaps", "standard_fonts", "wasm"])
  await fs.cp(
    path.join(root, "node_modules/pdfjs-dist", dir),
    path.join(vendor, dir),
    { recursive: true },
  );
await fs.mkdir(path.join(vendor, "ocr"), { recursive: true });
for (const name of ["tesseract.esm.min.js", "worker.min.js"])
  await fs.copyFile(
    path.join(root, "node_modules/tesseract.js/dist", name),
    path.join(vendor, "ocr", name),
  );
for (const name of ["tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm"])
  await fs.copyFile(
    path.join(root, "node_modules/tesseract.js-core", name),
    path.join(vendor, "ocr", name),
  );
const assets = {
  "ocr/eng.traineddata":
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata",
  "ocr/chi_sim.traineddata":
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/chi_sim.traineddata",
  "NotoSansCJKsc-Regular.otf":
    "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
  "Noto-LICENSE.txt":
    "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE",
  "ocr/DATA-LICENSE.txt":
    "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/LICENSE",
};
if (process.argv.includes("--download-assets"))
  for (const [name, url] of Object.entries(assets)) {
    const target = path.join(vendor, name);
    try {
      await fs.access(target);
      continue;
    } catch {}
    const response = await fetch(url);
    if (!response.ok)
      throw Error("Asset fetch failed: " + url + " " + response.status);
    await fs.writeFile(target, new Uint8Array(await response.arrayBuffer()));
    console.log("asset", name);
  }
let licenses = "# Bundled libraries\n";
for (const name of [
  "fflate",
  "pdfjs-dist",
  "pdf-lib",
  "@pdf-lib/fontkit",
  "tesseract.js",
  "tesseract.js-core",
]) {
  const dir = path.join(root, "node_modules", name),
    pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json")));
  licenses += `\n## ${name} ${pkg.version}\n${pkg.license}\n`;
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt"])
    try {
      licenses += await fs.readFile(path.join(dir, file), "utf8");
      break;
    } catch {}
}
await fs.writeFile(path.join(vendor, "LICENSES.txt"), licenses);
console.log("Local vendor build complete");
