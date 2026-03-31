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

function normalizeGroupedId(message) {
  const groupedId = message?.groupedId ?? message?.grouped_id ?? null;
  if (groupedId == null) return null;
  return String(groupedId).trim();
}

function buildGroupAnchorMap(messages) {
  const map = new Map();
  for (const message of messages) {
    const groupedId = normalizeGroupedId(message);
    if (!groupedId) continue;
    const messageId = Number(message.id);
    const existing = map.get(groupedId);
    if (!existing || messageId < existing.numericMessageId) {
      map.set(groupedId, {
        numericMessageId: messageId,
        anchorExternalId: String(message.id),
      });
    }
  }
  return map;
}

function extensionFromMimeType(mimeType, fallback = "bin") {
  const normalized = String(mimeType ?? "").toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("jpg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("quicktime")) return "mov";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mkv")) return "mkv";
  return fallback;
}

function classifyMediaMessage(message) {
  const mediaClassName = message?.media?.className ?? "";
  if (mediaClassName === "MessageMediaPhoto") {
    return {
      isSupported: true,
      mediaKind: "image",
      mimeType: "image/jpeg",
      extension: "jpg",
    };
  }

  if (mediaClassName === "MessageMediaDocument") {
    const mimeType = String(message?.media?.document?.mimeType ?? "").toLowerCase();
    if (mimeType.startsWith("video/")) {
      return {
        isSupported: true,
        mediaKind: "video",
        mimeType,
        extension: extensionFromMimeType(mimeType, "mp4"),
      };
    }
    if (mimeType.startsWith("image/")) {
      return {
        isSupported: true,
        mediaKind: "image",
        mimeType,
        extension: extensionFromMimeType(mimeType, "jpg"),
      };
    }
  }

  return { isSupported: false };
}

async function loadAlreadyImportedIdentifiers() {
  const { data, error } = await supabase
    .from("media_uploads")
    .select(
      "id, original_filename, source_channel_id, source_post_external_id, source_grouped_id, media_kind, mime_type"
    )
    .eq("source", "telegram_channel")
    .not("original_filename", "is", null);

  if (error) {
    console.warn("Could not load already imported media:", error.message);
    return new Set();
  }

  const map = new Map();
  for (const row of data ?? []) {
    if (!row.original_filename) continue;
    map.set(row.original_filename, row);
  }
  return map;
}

async function importMediaMessage(
  client,
  message,
  channelLabel,
  existingIdentifiers,
  groupAnchorMap
) {
  const mediaInfo = classifyMediaMessage(message);
  if (!mediaInfo.isSupported) {
    return "skipped";
  }

  const mediaIdentifier = buildTelegramMediaIdentifier(channelLabel, message.id);
  const groupedId = normalizeGroupedId(message);
  const groupedAnchor = groupedId ? groupAnchorMap.get(groupedId) : null;
  const sourcePostExternalId = groupedAnchor?.anchorExternalId ?? String(message.id);
  const existingRow = existingIdentifiers.get(mediaIdentifier);
  const publishedAt = message.date ? new Date(message.date * 1000).toISOString() : null;

  if (existingRow) {
    const metadataPatch = {};
    if (existingRow.source_channel_id !== channelLabel) {
      metadataPatch.source_channel_id = channelLabel;
    }
    if (existingRow.source_post_external_id !== sourcePostExternalId) {
      metadataPatch.source_post_external_id = sourcePostExternalId;
    }
    if ((existingRow.source_grouped_id ?? null) !== groupedId) {
      metadataPatch.source_grouped_id = groupedId;
    }
    if ((existingRow.media_kind ?? "image") !== mediaInfo.mediaKind) {
      metadataPatch.media_kind = mediaInfo.mediaKind;
    }
    if ((existingRow.mime_type ?? "").toLowerCase() !== mediaInfo.mimeType.toLowerCase()) {
      metadataPatch.mime_type = mediaInfo.mimeType;
    }

    if (Object.keys(metadataPatch).length === 0) {
      return "skipped";
    }

    const { error: updateError } = await supabase
      .from("media_uploads")
      .update(metadataPatch)
      .eq("id", existingRow.id);

    if (updateError) {
      console.error(`  [error] Update media #${message.id}: ${updateError.message}`);
      return "error";
    }

    return "updated";
  }

  const mediaBuffer = await client.downloadMedia(message, {});
  if (!mediaBuffer || mediaBuffer.length === 0) {
    return "skipped";
  }

  const objectKey = `telegram/${randomUUID()}.${mediaInfo.extension}`;
  await uploadBufferToMinio(Buffer.from(mediaBuffer), objectKey, mediaInfo.mimeType);

  const mediaRecord = {
    kind: "user",
    bucket_name: config.minio.bucketMedia,
    object_key: objectKey,
    url: `${config.minio.endpoint}/${config.minio.bucketMedia}/${objectKey}`,
    source: "telegram_channel",
    source_channel_id: channelLabel,
    source_post_external_id: sourcePostExternalId,
    source_grouped_id: groupedId,
    media_kind: mediaInfo.mediaKind,
    mime_type: mediaInfo.mimeType,
    file_size_bytes: Number(mediaBuffer.length),
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
  const mediaMessages = messages.filter((message) => classifyMediaMessage(message).isSupported);
  const videoCount = mediaMessages.filter(
    (message) => classifyMediaMessage(message).mediaKind === "video"
  ).length;
  const imageCount = mediaMessages.length - videoCount;
  const groupAnchorMap = buildGroupAnchorMap(messages);

  console.log(
    `Found ${mediaMessages.length} supported media (images: ${imageCount}, videos: ${videoCount}) out of ${messages.length} messages.`
  );

  const existingIdentifiers = await loadAlreadyImportedIdentifiers();
  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const message of mediaMessages) {
    const result = await importMediaMessage(
      client,
      message,
      sourceChannel,
      existingIdentifiers,
      groupAnchorMap
    );
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

  await client.disconnect();
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
