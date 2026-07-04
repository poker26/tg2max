#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "crypto";
import { config } from "../src/config.js";
import { getMaxBotMe } from "../src/max/api.js";
import { collectSyncEvents } from "../src/sync/collector.js";
import { dispatchSyncEvents } from "../src/sync/dispatcher.js";
import { acquireDistributedLock, releaseDistributedLock } from "../src/sync/repository.js";

const sourceChannelId = config.sync.sourceChannel;
const targetChatId = config.max.targetChatId;
const workerOwnerId = randomUUID();

if (!sourceChannelId) {
  console.error("SYNC_SOURCE_CHANNEL is required.");
  process.exit(1);
}

if (!targetChatId || !/^-?\d+$/.test(String(targetChatId).trim())) {
  console.error("MAX_TARGET_CHAT_ID is required and must be numeric.");
  process.exit(1);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSingleIteration() {
  const lockAcquired = await acquireDistributedLock({
    lockName: config.sync.lockName,
    ownerId: workerOwnerId,
    ttlMs: config.sync.lockTtlMs,
  });
  if (!lockAcquired) {
    console.log("[sync-worker] Skip iteration, another worker holds lock.");
    return;
  }

  try {
    const collectStats = await collectSyncEvents({
      sourceChannelId,
      targetChatId,
    });
    const dispatchStats = await dispatchSyncEvents({
      targetChatId,
    });
    console.log("[sync-worker] iteration done", {
      collectStats,
      dispatchStats,
    });
  } finally {
    await releaseDistributedLock({
      lockName: config.sync.lockName,
      ownerId: workerOwnerId,
    });
  }
}

async function main() {
  console.log("TG master -> MAX mirror sync worker");
  console.log(`Source TG channel: ${sourceChannelId}`);
  console.log(`Target MAX chat: ${targetChatId}`);
  console.log(`Polling interval: ${config.sync.pollIntervalMs}ms`);

  const maxBot = await getMaxBotMe();
  console.log(
    `MAX bot connected: user_id=${maxBot?.user_id ?? maxBot?.id ?? "?"}, username=${maxBot?.username ?? "(none)"}`
  );

  while (true) {
    try {
      await runSingleIteration();
    } catch (error) {
      console.error("[sync-worker] iteration failed:", error.message);
    }
    await sleep(config.sync.pollIntervalMs);
  }
}

main().catch((error) => {
  console.error("Fatal sync worker error:", error.message);
  process.exit(1);
});
