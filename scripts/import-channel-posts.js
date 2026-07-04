#!/usr/bin/env node
import "dotenv/config";
import { config } from "../src/config.js";
import { withTelegramClient } from "../src/telegram/client.js";
import { filterImportableMessages, upsertChannelPosts } from "../src/telegram/import-posts.js";

const cliArgs = process.argv.slice(2);
const channelArg = cliArgs.find((arg) => arg.startsWith("@"));
const sourceChannel = channelArg;

if (!sourceChannel) {
  console.error("Source channel is required. Pass @channel.");
  process.exit(1);
}

async function main() {
  console.log(`Connecting to Telegram and reading posts from ${sourceChannel}...`);
  await withTelegramClient(async (client) => {
    const allMessages = await client.getMessages(sourceChannel, {
      limit: config.telegram.importLimit,
    });
    const importableMessages = filterImportableMessages(allMessages);
    console.log(
      `Found ${importableMessages.length} posts (text and/or media) out of ${allMessages.length} messages.`
    );
    const importStats = await upsertChannelPosts(importableMessages, sourceChannel);
    console.log(`Saved ${importStats.savedCount} new posts and updated ${importStats.updatedCount}.`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
