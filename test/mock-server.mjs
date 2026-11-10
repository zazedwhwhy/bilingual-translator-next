import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function startMock(port = 8787) {
  let mode = "ok";
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url.startsWith("/api/asr")) {
      const pieces = [];
      for await (const chunk of req) pieces.push(chunk);
      const raw = Buffer.concat(pieces),
        text = raw.toString("latin1"),
        model = text.match(/name="model"\r\n\r\n([^\r]+)/)?.[1] || "";
      requests.push({
        provider: "asr",
        bytes: raw.length,
        hasWave: raw.includes(Buffer.from("RIFF")),
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
        credentialInBody: text.includes("asr-test-key"),
        model,
      });
      if (model === "mock-delay") await new Promise((r) => setTimeout(r, 2500));
      if (model === "mock-fail") {
        res.writeHead(500);
        res.end("{}");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          model === "mock-no-time"
            ? { text: "No timestamps" }
            : {
                segments:
                  model === "mock-capture"
                    ? [
                        { start: 0, end: 0.12, text: "Recognized first line" },
                        {
                          start: 0.15,
                          end: 0.25,
                          text: "Recognized second line",
                        },
                      ]
                    : [
                        { start: 0, end: 0.8, text: "Recognized first line" },
                        { start: 1, end: 1.9, text: "Recognized second line" },
                      ],
              },
        ),
      );
      return;
    }
    if (req.url.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw),
        provider = req.url.split("/")[2].split("?")[0];
      requests.push({ provider, body, at: Date.now() });
      const m = body.model?.startsWith("mock-") ? body.model.slice(5) : mode;
      if (["401", "403", "429", "500"].includes(m)) {
        res.writeHead(Number(m), { "Retry-After": "1" });
        res.end("{}");
        return;
      }
      if (m === "delay") await new Promise((r) => setTimeout(r, 2500));
      if (m === "latency") await new Promise((r) => setTimeout(r, 120));
      if (m === "disconnect") {
        res.destroy();
        return;
      }
      if (m === "redirect") {
        res.writeHead(302, { Location: "https://example.invalid" });
        res.end();
        return;
      }
      if (m === "oversize") {
        res.end("x".repeat(262145));
        return;
      }
      if (m === "invalid") {
        res.end("not JSON");
        return;
      }
      if (provider === "google") {
        res.end(
          JSON.stringify({
            data: {
              translations: body.q.map((t) => ({
                translatedText: "MOCK 译文：" + t,
              })),
            },
          }),
        );
        return;
      }
      const input = JSON.parse(body.messages.at(-1).content);
      const translations = input.items.map((x) => ({
        id: x.id,
        text: "MOCK 译文：" + x.text,
      }));
      if (m === "missing") translations.pop();
      const output = JSON.stringify({ translations });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          provider === "claude"
            ? {
                stop_reason: m === "truncated" ? "max_tokens" : "end_turn",
                content: [{ type: "text", text: output }],
              }
            : {
                choices: [
                  {
                    finish_reason: m === "truncated" ? "length" : "stop",
                    message: { content: output },
                  },
                ],
              },
        ),
      );
      return;
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const location = req.url.split("?")[0];
    const file = location.startsWith("/src/")
      ? path.join(root, location)
      : path.join(
          root,
          "test/fixtures",
          location === "/" ? "static.html" : location,
        );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      res.setHeader(
        "Content-Type",
        file.endsWith(".vtt")
          ? "text/vtt"
          : file.endsWith(".webm")
            ? "video/webm"
            : file.endsWith(".js") || file.endsWith(".mjs")
              ? "text/javascript"
              : "text/html; charset=utf-8",
      );
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, requests, setMode: (m) => (mode = m) }),
    ),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startMock();
  console.log("Mock running at http://127.0.0.1:8787");
}
