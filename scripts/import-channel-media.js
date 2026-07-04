#!/usr/bin/env node
import "dotenv/config";
import { config } from "../src/config.js";
import { withTelegramClient } from "../src/telegram/client.js";
import {
  buildGroupAnchorMap,
  classifyMediaMessage,
  importMediaMessage,
  loadAlreadyImportedIdentifiers,
} from "../src/telegram/import-media.js";

const cliArgs = process.argv.slice(2);
const limitFlagIndex = cliArgs.indexOf("--limit");
const limitValue = limitFlagIndex >= 0 ? parseInt(cliArgs[limitFlagIndex + 1] || "200", 10) : config.telegram.importLimit;
const channelArg = cliArgs.find((arg) => arg.startsWith("@"));
const sourceChannel = channelArg;

if (!sourceChannel) {
  console.error("Source channel is required. Pass @channel.");
  process.exit(1);
}
if (!config.minio.endpoint) {
  console.error("MINIO_ENDPOINT is required for media import.");
  process.exit(1);
}

async function main() {
  console.log(`Connecting to Telegram and reading media from ${sourceChannel}...`);
  await withTelegramClient(async (client) => {
    const messages = await client.getMessages(sourceChannel, { limit: limitValue });
    const mediaMessages = messages.filter((message) => classifyMediaMessage(message).isSupported);
    const videoCount = mediaMessages.filter(
      (message) => classifyMediaMessage(message).mediaKind === "video"
    ).length;
    const imageCount = mediaMessages.length - videoCount;
    const groupAnchorMap = buildGroupAnchorMap(messages);

    console.log(
      `Found ${mediaMessages.length} supported media (images: ${imageCount}, videos: ${videoCount}) out of ${messages.length} messages.`
    );

    const existingIdentifiers = await loadAlreadyImportedIdentifiers(sourceChannel);
    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const message of mediaMessages) {
      const result = await importMediaMessage({
        client,
        message,
        channelLabel: sourceChannel,
        existingIdentifiers,
        groupAnchorMap,
      });
      if (result === "imported") importedCount++;
      if (result === "updated") updatedCount++;
      if (result === "skipped") skippedCount++;
      if (result === "error") errorCount++;
    }

    console.log("Done.");
    console.log(`  Imported: ${importedCount}`);
    console.log(`  Updated:  ${updatedCount}`);
    console.log(`  Skipped:  ${skippedCount}`);
    console.log(`  Errors:   ${errorCount}`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
