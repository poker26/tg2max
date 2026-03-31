#!/usr/bin/env node
import "dotenv/config";
import http from "http";
import { spawn } from "child_process";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, "..", "web");
const DEFAULT_PORT = parseInt(process.env.TG2MAX_WEB_PORT || "3020", 10);

let runningProcess = null;

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function normalizeTelegramChannel(value) {
  const trimmedValue = String(value ?? "").trim();
  if (!trimmedValue) return "";
  if (trimmedValue.startsWith("@")) return trimmedValue;
  return `@${trimmedValue}`;
}

function validateMaxChatId(value) {
  const trimmedValue = String(value ?? "").trim();
  if (!trimmedValue) return "";
  if (!/^-?\d+$/.test(trimmedValue)) return "";
  return trimmedValue;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function buildCrosspostArguments({ telegramChannel, maxChatId, mode }) {
  const argumentsList = ["scripts/telegram-to-max.js", "--max-chat-id", maxChatId];

  if (mode === "test") {
    argumentsList.push("--limit", "5");
    argumentsList.push("--newest-first");
  } else {
    argumentsList.push("--limit", "10000");
  }

  argumentsList.push(telegramChannel);
  return argumentsList;
}

function streamCommandOutput(response, commandArguments) {
  response.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  runningProcess = spawn("node", commandArguments, {
    cwd: join(__dirname, ".."),
    env: process.env,
    windowsHide: true,
  });

  const startedAtIsoString = new Date().toISOString();
  response.write(`[${startedAtIsoString}] Starting: node ${commandArguments.join(" ")}\n\n`);

  const writeChunk = (chunk) => {
    if (!response.writableEnded) {
      response.write(chunk.toString("utf8"));
    }
  };

  runningProcess.stdout.on("data", writeChunk);
  runningProcess.stderr.on("data", writeChunk);

  runningProcess.on("error", (error) => {
    writeChunk(`\n[ERROR] ${error.message}\n`);
    if (!response.writableEnded) {
      response.end();
    }
    runningProcess = null;
  });

  runningProcess.on("close", (code) => {
    writeChunk(`\n[DONE] Process exited with code ${code}\n`);
    if (!response.writableEnded) {
      response.end();
    }
    runningProcess = null;
  });

  response.on("close", () => {
    // Do not kill the running export when the HTTP connection closes.
    // Reverse proxies or browser-side reconnects may close the stream early.
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    try {
      const html = await readFile(join(WEB_ROOT, "index.html"), "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    } catch (error) {
      writeJson(response, 500, { error: `Failed to load UI: ${error.message}` });
      return;
    }
  }

  if (request.method === "POST" && request.url === "/api/run") {
    if (runningProcess) {
      writeJson(response, 409, { error: "Another export is already running." });
      return;
    }

    let requestPayload;
    try {
      const body = await readRequestBody(request);
      requestPayload = JSON.parse(body || "{}");
    } catch {
      writeJson(response, 400, { error: "Invalid JSON body." });
      return;
    }

    const telegramChannel = normalizeTelegramChannel(requestPayload.telegramChannel);
    const maxChatId = validateMaxChatId(requestPayload.maxChatId);
    const mode = requestPayload.mode === "test" ? "test" : "full";

    if (!telegramChannel) {
      writeJson(response, 400, { error: "Telegram channel is required." });
      return;
    }
    if (!maxChatId) {
      writeJson(response, 400, { error: "MAX chat id is required and must be numeric." });
      return;
    }

    const commandArguments = buildCrosspostArguments({ telegramChannel, maxChatId, mode });
    streamCommandOutput(response, commandArguments);
    return;
  }

  if (request.method === "GET" && request.url === "/api/status") {
    writeJson(response, 200, { running: Boolean(runningProcess) });
    return;
  }

  writeJson(response, 404, { error: "Not found" });
});

server.listen(DEFAULT_PORT, () => {
  console.log(`tg2max web UI: http://0.0.0.0:${DEFAULT_PORT}`);
});
