#!/usr/bin/env node
// One-off cutover helper: seed message_map so the sync worker treats every
// Telegram message currently in the poll window as ALREADY mirrored to MAX.
//
// Without this, a fresh worker start (empty message_map) would classify all
// recent posts as "create" events and re-publish the entire channel into the
// MAX chat that already received it via the legacy crosspost pipeline.
//
// The seeded last_source_hash is computed with the exact same function the
// collector uses, so the first (and subsequent) collect iterations produce no
// create/update events until a source message actually changes.
//
// target_message_id is left null because the legacy pipeline never recorded the
// MAX message ids. Consequence: a later edit/delete of a seeded post cannot be
// applied in-place in MAX — an edit re-publishes once, a delete is a no-op.
// Only posts created AFTER the seed get full edit/delete mirroring.
//
// Usage: node scripts/seed-message-map.js @channel [--dry-run]

import "dotenv/config";
import { config } from "../src/config.js";
import { withTelegramClient } from "../src/telegram/client.js";
import { filterImportableMessages } from "../src/telegram/import-posts.js";
import { buildPostPayloadForHash } from "../src/sync/collector.js";
import { buildSourcePayloadHash } from "../src/sync/hash.js";
import { loadMediaRowsForSourcePosts, upsertMessageMap } from "../src/sync/repository.js";

const cliArgs = process.argv.slice(2);
const dryRun = cliArgs.includes("--dry-run");
const sourceChannelId = cliArgs.find((arg) => arg.startsWith("@")) || config.sync.sourceChannel;
const targetChatId = config.max.targetChatId;

if (!sourceChannelId) {
  console.error("Source channel is required. Pass @channel or set SYNC_SOURCE_CHANNEL.");
  process.exit(1);
}
if (!targetChatId || !/^-?\d+$/.test(String(targetChatId).trim())) {
  console.error("MAX_TARGET_CHAT_ID is required and must be numeric.");
  process.exit(1);
}

async function main() {
  console.log("Seed message_map (cutover to sync worker)");
  console.log(`Source TG channel: ${sourceChannelId}`);
  console.log(`Target MAX chat:   ${targetChatId}`);
  console.log(`Poll window limit: ${config.sync.pollLimit}`);
  console.log(`Dry run:           ${dryRun}\n`);

  let seeded = 0;
  let skipped = 0;

  await withTelegramClient(async (client) => {
    const messages = await client.getMessages(sourceChannelId, { limit: config.sync.pollLimit });
    const importableMessages = filterImportableMessages(messages);
    console.log(`Importable messages in window: ${importableMessages.length}`);

    const sourceMessageIds = importableMessages.map((message) => Number(message.id));
    const sourcePostExternalIds = sourceMessageIds.map((messageId) => String(messageId));
    const mediaRows = await loadMediaRowsForSourcePosts(sourceChannelId, sourcePostExternalIds);
    const mediaBySourcePostExternalId = new Map();
    for (const mediaRow of mediaRows) {
      const key = String(mediaRow.source_post_external_id ?? "");
      if (!mediaBySourcePostExternalId.has(key)) mediaBySourcePostExternalId.set(key, []);
      mediaBySourcePostExternalId.get(key).push(mediaRow);
    }

    for (const message of importableMessages) {
      const sourceMessageId = Number(message.id);
      const postPayload = buildPostPayloadForHash({
        message,
        mediaRows: mediaBySourcePostExternalId.get(String(sourceMessageId)) ?? [],
      });
      const payloadHash = buildSourcePayloadHash(postPayload);

      if (dryRun) {
        seeded++;
        continue;
      }

      await upsertMessageMap({
        sourceChannelId,
        sourceMessageId,
        targetChatId,
        targetMessageId: null,
        lastSourceHash: payloadHash,
        deletedAt: null,
      });
      seeded++;
    }
  });

  console.log("\nDone.");
  console.log(`  Seeded/would-seed message_map rows: ${seeded}`);
  console.log(`  Skipped: ${skipped}`);
  if (dryRun) {
    console.log("\n(dry-run: no rows written)");
  }
}

main().catch((error) => {
  console.error("Fatal seed error:", error.message);
  process.exit(1);
});
