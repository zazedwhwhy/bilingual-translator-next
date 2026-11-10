import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.BT_PLAYWRIGHT ||
    "C:/Users/wange/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = http.createServer(async (req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<p id="reading">A normal useful sentence.</p><input id="text" value="Hello world!"><textarea id="area">Original note</textarea><div id="rich" contenteditable="true">Hello <b>world</b></div><input id="password" type="password" value="private"><input id="card" autocomplete="cc-number"><input id="otp" autocomplete="one-time-code"><input id="readonly" readonly><div id="aria-readonly" contenteditable="true" aria-readonly="true">Read only editor</div><input id="no-translate" translate="no"><div class="monaco-editor"><textarea id="code">code</textarea></div>`,
    );
    return;
  }
  const target = path.resolve(
    root,
    "src",
    "." + new URL(req.url, "http://127.0.0.1").pathname,
  );
  if (!target.startsWith(path.join(root, "src") + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader("Content-Type", "text/javascript");
  try {
    res.end(await fs.readFile(target));
  } catch {
    res.end("export {}");
  }
});
await new Promise((resolve) => server.listen(8788, "127.0.0.1", resolve));
let browser;
const checks = [];
try {
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8788/");
  const exports = await page.evaluate(async () => {
    globalThis.targets = await import("/content/interaction-targets.js");
    return Object.keys(targets);
  });
  assert.ok(
    exports.includes("inputSnapshot"),
    "DOM input translation module must be implemented",
  );
  const result = await page.evaluate(() => {
    const input = document.getElementById("text");
    input.focus();
    input.setSelectionRange(6, 11);
    const transaction = targets.applyInput(
      targets.inputSnapshot(input),
      "世界",
    );
    const applied = input.value;
    targets.undoInput(transaction);
    return { applied, original: input.value };
  });
  assert.deepEqual(result, {
    applied: "Hello 世界!",
    original: "Hello world!",
  });
  checks.push(
    "only selected input text is replaced and undo restores original",
  );
  const changed = await page.evaluate(() => {
    const input = document.getElementById("area"),
      snapshot = targets.inputSnapshot(input);
    input.value = "My newer note";
    try {
      targets.applyInput(snapshot, "stale");
    } catch (error) {
      return { code: error.code, value: input.value };
    }
  });
  assert.deepEqual(changed, { code: "INPUT_CHANGED", value: "My newer note" });
  checks.push("late translation cannot overwrite new input");
  const blocked = await page.evaluate(() => {
    const input = document.getElementById("text");
    input.setSelectionRange(0, input.value.length);
    const before = targets.inputSnapshot(input);
    input.addEventListener("beforeinput", (event) => event.preventDefault(), {
      once: true,
    });
    try {
      targets.applyInput(before, "blocked");
    } catch (error) {
      return { code: error.code, value: input.value };
    }
  });
  assert.deepEqual(blocked, { code: "INPUT_REJECTED", value: "Hello world!" });
  checks.push("cancelled beforeinput is respected");
  const sensitive = await page.evaluate(() =>
    [
      "password",
      "card",
      "otp",
      "readonly",
      "code",
      "aria-readonly",
      "no-translate",
    ].map((id) => targets.editableTarget(document.getElementById(id)) === null),
  );
  assert.deepEqual(sensitive, [true, true, true, true, true, true, true]);
  checks.push(
    "password/payment/OTP/readonly/code/ARIA-readonly/translate-no targets are excluded",
  );
  const rich = await page.evaluate(() => {
    const element = document.getElementById("rich");
    element.focus();
    getSelection().removeAllRanges();
    const before = element.innerHTML,
      snapshot = targets.inputSnapshot(element);
    const transaction = targets.applyInput(snapshot, "你好世界");
    const translated = element.innerText;
    targets.undoInput(transaction);
    return { translated, restored: element.innerHTML === before };
  });
  assert.deepEqual(rich, { translated: "你好世界", restored: true });
  checks.push(
    "simple contenteditable supports replacement and exact original markup restoration",
  );
  const undo = await page.evaluate(() => {
    const input = document.getElementById("text");
    input.focus();
    input.setSelectionRange(0, input.value.length);
    const transaction = targets.applyInput(
      targets.inputSnapshot(input),
      "Translation",
    );
    input.value = "Continued typing";
    try {
      targets.undoInput(transaction);
    } catch (error) {
      return { code: error.code, value: input.value };
    }
  });
  assert.deepEqual(undo, { code: "INPUT_CHANGED", value: "Continued typing" });
  checks.push("undo cannot overwrite edits made after translation");
  const reviewed = await page.evaluate(() => {
    const privacy = [
      "Credit card number",
      "Verification code",
      "Security code",
      "Debit card",
    ].map((label) => {
      const field = document.createElement("input");
      field.type = "text";
      field.autocomplete = "off";
      field.setAttribute("aria-label", label);
      document.body.append(field);
      const excluded = targets.editableTarget(field) === null;
      field.remove();
      return excluded;
    });
    const input = document.getElementById("text");
    input.value = "Original";
    input.focus();
    input.setSelectionRange(0, input.value.length);
    const native = targets.inputSnapshot(input);
    input.addEventListener(
      "input",
      () => {
        input.value = "Original";
      },
      { once: true },
    );
    let nativeCode = "SUCCESS";
    try {
      targets.applyInput(native, "New translation");
    } catch (error) {
      nativeCode = error.code;
    }
    const rich = document.getElementById("rich");
    rich.innerHTML = "Original <b>rich</b>";
    rich.focus();
    getSelection().removeAllRanges();
    const formatted = targets.inputSnapshot(rich);
    rich.addEventListener(
      "input",
      () => {
        rich.innerHTML = "Original <b>rich</b>";
      },
      { once: true },
    );
    let richCode = "SUCCESS";
    try {
      targets.applyInput(formatted, "New rich translation");
    } catch (error) {
      richCode = error.code;
    }
    return { privacy, nativeCode, richCode };
  });
  assert.deepEqual(reviewed, {
    privacy: [true, true, true, true],
    nativeCode: "INPUT_REJECTED",
    richCode: "INPUT_REJECTED",
  });
  checks.push(
    "English payment/verification metadata is excluded; host rejection cannot be reported as a successful replacement",
  );
  console.log(JSON.stringify({ checks, browser: browser.version() }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
