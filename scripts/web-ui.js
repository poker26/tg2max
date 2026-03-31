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
let runSequence = 0;
let activeRun = null;

function appendRunLog(text) {
  if (!activeRun) return;
  activeRun.output += text;
  if (activeRun.output.length > 1_000_000) {
    activeRun.output = activeRun.output.slice(-500_000);
    activeRun.truncated = true;
  }
}

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

function startBackgroundRun(commandArguments) {
  runningProcess = spawn("node", commandArguments, {
    cwd: join(__dirname, ".."),
    env: process.env,
    windowsHide: true,
  });

  runSequence += 1;
  activeRun = {
    id: runSequence,
    mode: commandArguments.includes("--newest-first") ? "test" : "full",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: "",
    truncated: false,
  };

  appendRunLog(`[${activeRun.startedAt}] Starting: node ${commandArguments.join(" ")}\n\n`);

  const writeChunk = (chunk) => {
    appendRunLog(chunk.toString("utf8"));
  };

  runningProcess.stdout.on("data", writeChunk);
  runningProcess.stderr.on("data", writeChunk);

  runningProcess.on("error", (error) => {
    writeChunk(`\n[ERROR] ${error.message}\n`);
    if (activeRun) {
      activeRun.finishedAt = new Date().toISOString();
      activeRun.exitCode = -1;
    }
    runningProcess = null;
  });

  runningProcess.on("close", (code) => {
    writeChunk(`\n[DONE] Process exited with code ${code}\n`);
    if (activeRun) {
      activeRun.finishedAt = new Date().toISOString();
      activeRun.exitCode = code;
    }
    runningProcess = null;
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/") {
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

  if (request.method === "POST" && requestUrl.pathname === "/api/run") {
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
    startBackgroundRun(commandArguments);
    writeJson(response, 200, {
      ok: true,
      runId: activeRun?.id ?? null,
      startedAt: activeRun?.startedAt ?? null,
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    writeJson(response, 200, {
      running: Boolean(runningProcess),
      runId: activeRun?.id ?? null,
      startedAt: activeRun?.startedAt ?? null,
      finishedAt: activeRun?.finishedAt ?? null,
      exitCode: activeRun?.exitCode ?? null,
      outputLength: activeRun?.output.length ?? 0,
      truncated: Boolean(activeRun?.truncated),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/logs") {
    const requestedRunId = parseInt(requestUrl.searchParams.get("runId") || "", 10);
    const offset = Math.max(0, parseInt(requestUrl.searchParams.get("offset") || "0", 10));
    if (!activeRun || Number.isNaN(requestedRunId) || requestedRunId !== activeRun.id) {
      writeJson(response, 404, { error: "Run not found." });
      return;
    }

    const safeOffset = Math.min(offset, activeRun.output.length);
    const chunk = activeRun.output.slice(safeOffset);
    writeJson(response, 200, {
      runId: activeRun.id,
      running: Boolean(runningProcess),
      finishedAt: activeRun.finishedAt,
      exitCode: activeRun.exitCode,
      truncated: activeRun.truncated,
      chunk,
      nextOffset: safeOffset + chunk.length,
    });
    return;
  }

  writeJson(response, 404, { error: "Not found" });
});

server.listen(DEFAULT_PORT, () => {
  console.log(`tg2max web UI: http://0.0.0.0:${DEFAULT_PORT}`);
});
