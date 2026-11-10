import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
const require = createRequire(import.meta.url),
  { chromium } = require(
    process.env.BT_PLAYWRIGHT ||
      "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  version = JSON.parse(
    await fs.readFile(path.join(root, "manifest.json")),
  ).version,
  archive = path.join(
    root,
    "dist/bilingual-translator-next-" + version + ".zip",
  ),
  output = path.resolve(root, "../../.tmp/release-smoke-" + version),
  bundle = path.join(output, "unpacked"),
  profile = path.join(output, "owned-profile-" + Date.now());
await fs.mkdir(bundle, { recursive: true });
const bytes = await fs.readFile(archive),
  files = unzipSync(bytes);
let count = 0,
  total = 0;
for (const [name, data] of Object.entries(files)) {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.endsWith("/")) continue;
  assert.ok(
    normalized === "manifest.json" || normalized === "LICENSE" || normalized.startsWith("src/"),
    "release must contain only manifest, src and LICENSE",
  );
  assert.ok(!normalized.split("/").includes(".."));
  assert.deepEqual(
    data,
    new Uint8Array(await fs.readFile(path.join(root, normalized))),
    "archive bytes must match production " + normalized,
  );
  const target = path.resolve(bundle, normalized);
  assert.ok(target.startsWith(bundle + path.sep));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  count++;
  total += data.length;
}
const manifest = JSON.parse(
  await fs.readFile(path.join(bundle, "manifest.json")),
);
assert.equal(manifest.version, version);
assert.equal(manifest.host_permissions, undefined);
const sha = createHash("sha256").update(bytes).digest("hex").toUpperCase();
assert.ok(
  (
    await fs.readFile(
      path.join(root, "dist/SHA256-" + version + ".txt"),
      "utf8",
    )
  ).includes(sha),
);
let context;
const errors = [],
  external = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args: [
      `--load-extension=${bundle}`,
      `--disable-extensions-except=${bundle}`,
    ],
    viewport: { width: 1280, height: 900 },
  });
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  context.on("request", (r) => {
    if (/^https?:/.test(r.url())) external.push(new URL(r.url()).origin);
  });
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  assert.equal(
    await worker.evaluate(() => chrome.runtime.getManifest().version),
    version,
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/ui/options.html`);
  await page.waitForFunction(
    () => !document.getElementById("asr-fields").disabled,
  );
  assert.equal(await page.locator("#key").inputValue(), "");
  await page.goto(`chrome-extension://${id}/src/ui/workbench.html`);
  await page
    .locator("#document-file")
    .setInputFiles(path.join(root, "test/fixtures/documents/sample.pdf"));
  await page.waitForFunction(() =>
    ["ready", "error"].includes(
      document.getElementById("document-status").dataset.phase,
    ),
  );
  assert.equal(
    await page.locator("#document-status").getAttribute("data-phase"),
    "ready",
    await page.locator("#document-status").textContent(),
  );
  assert.equal(await page.locator("#capture-start").count(), 1);
  assert.equal(errors.length, 0);
  assert.equal(external.length, 0);
  const report = {
    version: manifest.version,
    sha256: sha,
    archiveBytes: bytes.length,
    files: count,
    unpackedBytes: total,
    browser: context.browser().version(),
    checks: [
      "archive contains only production manifest/src",
      "every archive file matches source bytes",
      "no pregranted host permissions or credential",
      "clean Chrome loads service worker/options/workbench",
      "bundled PDF worker parses fixture without external request",
    ],
    pageErrors: errors,
    externalRequests: external,
  };
  await fs.writeFile(
    path.join(output, "release-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  const target = path.resolve(profile);
  if (
    !target.startsWith(output + path.sep) ||
    !path.basename(target).startsWith("owned-profile-")
  )
    throw Error("UNSAFE_PROFILE_PATH");
  await fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
