#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "crypto";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../src/config.js";
import { supabase } from "../src/db/supabase.js";
import { uploadBufferToMinio } from "../src/minio-client.js";

const cliArgs = process.argv.slice(2);
const limitFlagIndex = cliArgs.indexOf("--limit");
const limitValue = limitFlagIndex >= 0 ? parseInt(cliArgs[limitFlagIndex + 1] || "200", 10) : config.telegram.importLimit;
const channelArg = cliArgs.find((arg) => arg.startsWith("@"));
const sourceChannel = channelArg || config.telegram.sourceChannel;

if (!sourceChannel) {
  console.error("Source channel is required. Pass @channel or set TELEGRAM_SOURCE_CHANNEL.");
  process.exit(1);
}
if (!config.minio.endpoint) {
  console.error("MINIO_ENDPOINT is required for media import.");
  process.exit(1);
}

function buildTelegramMediaIdentifier(channelLabel, messageId) {
  const safeChannel = String(channelLabel).replace(/^@/, "");
  return `tg_${safeChannel}_${messageId}`;
}

async function loadAlreadyImportedIdentifiers() {
  const { data, error } = await supabase
    .from("media_uploads")
    .select("original_filename")
    .eq("source", "telegram_channel")
    .not("original_filename", "is", null);

  if (error) {
    console.warn("Could not load already imported media:", error.message);
    return new Set();
  }

  return new Set((data ?? []).map((row) => row.original_filename));
}

async function importPhotoMessage(client, message, channelLabel, existingIdentifiers) {
  const mediaIdentifier = buildTelegramMediaIdentifier(channelLabel, message.id);
  if (existingIdentifiers.has(mediaIdentifier)) {
    return "skipped";
  }

  const photoBuffer = await client.downloadMedia(message, {});
  if (!photoBuffer || photoBuffer.length === 0) {
    return "skipped";
  }

  const objectKey = `telegram/${randomUUID()}.jpg`;
  await uploadBufferToMinio(Buffer.from(photoBuffer), objectKey, "image/jpeg");

  const publishedAt = message.date ? new Date(message.date * 1000).toISOString() : null;
  const mediaRecord = {
    kind: "user",
    bucket_name: config.minio.bucketMedia,
    object_key: objectKey,
    url: `${config.minio.endpoint}/${config.minio.bucketMedia}/${objectKey}`,
    source: "telegram_channel",
    original_filename: mediaIdentifier,
    created_at: publishedAt,
  };

  const { error } = await supabase.from("media_uploads").insert(mediaRecord);
  if (error) {
    console.error(`  [error] Save media #${message.id}: ${error.message}`);
    return "error";
  }

  return "imported";
}

async function main() {
  const client = new TelegramClient(
    new StringSession(config.telegram.session),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 }
  );

  console.log(`Connecting to Telegram and reading media from ${sourceChannel}...`);
  await client.connect();

  const messages = await client.getMessages(sourceChannel, { limit: limitValue });
  const photoMessages = messages.filter((message) => message.media?.className === "MessageMediaPhoto");
  console.log(`Found ${photoMessages.length} photo messages (out of ${messages.length}).`);

  const existingIdentifiers = await loadAlreadyImportedIdentifiers();
  let importedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const message of photoMessages) {
    const result = await importPhotoMessage(client, message, sourceChannel, existingIdentifiers);
    if (result === "imported") importedCount++;
    if (result === "skipped") skippedCount++;
    if (result === "error") errorCount++;
  }

  console.log("Done.");
  console.log(`  Imported: ${importedCount}`);
  console.log(`  Skipped:  ${skippedCount}`);
  console.log(`  Errors:   ${errorCount}`);

  await client.disconnect();
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
