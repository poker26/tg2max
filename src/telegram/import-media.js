import { randomUUID } from "crypto";
import { config } from "../config.js";
import { supabase } from "../db/supabase.js";
import { uploadBufferToMinio } from "../minio-client.js";

export function buildTelegramMediaIdentifier(channelLabel, messageId) {
  const safeChannel = String(channelLabel).replace(/^@/, "");
  return `tg_${safeChannel}_${messageId}`;
}

function normalizeGroupedId(message) {
  const groupedId = message?.groupedId ?? message?.grouped_id ?? null;
  if (groupedId == null) return null;
  return String(groupedId).trim();
}

export function buildGroupAnchorMap(messages) {
  const map = new Map();
  for (const message of messages ?? []) {
    const groupedId = normalizeGroupedId(message);
    if (!groupedId) continue;
    const messageId = Number(message.id);
    const existingAnchor = map.get(groupedId);
    if (!existingAnchor || messageId < existingAnchor.numericMessageId) {
      map.set(groupedId, {
        numericMessageId: messageId,
        anchorExternalId: String(message.id),
      });
    }
  }
  return map;
}

function extensionFromMimeType(mimeType, fallback = "bin") {
  const normalizedMimeType = String(mimeType ?? "").toLowerCase();
  if (normalizedMimeType.includes("jpeg")) return "jpg";
  if (normalizedMimeType.includes("jpg")) return "jpg";
  if (normalizedMimeType.includes("png")) return "png";
  if (normalizedMimeType.includes("gif")) return "gif";
  if (normalizedMimeType.includes("webp")) return "webp";
  if (normalizedMimeType.includes("mp4")) return "mp4";
  if (normalizedMimeType.includes("quicktime")) return "mov";
  if (normalizedMimeType.includes("webm")) return "webm";
  if (normalizedMimeType.includes("mkv")) return "mkv";
  return fallback;
}

export function classifyMediaMessage(message) {
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

export async function loadAlreadyImportedIdentifiers(channelUsername) {
  const { data, error } = await supabase
    .from("media_uploads")
    .select(
      "id, original_filename, source_channel_id, source_post_external_id, source_grouped_id, media_kind, mime_type"
    )
    .eq("source", "telegram_channel")
    .eq("source_channel_id", channelUsername)
    .not("original_filename", "is", null);

  if (error) {
    console.warn("Could not load already imported media:", error.message);
    return new Map();
  }

  const identifiersMap = new Map();
  for (const row of data ?? []) {
    if (!row.original_filename) continue;
    identifiersMap.set(row.original_filename, row);
  }
  return identifiersMap;
}

export async function importMediaMessage({
  client,
  message,
  channelLabel,
  existingIdentifiers,
  groupAnchorMap,
}) {
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

  const { error: insertError } = await supabase.from("media_uploads").insert(mediaRecord);
  if (insertError) {
    console.error(`  [error] Save media #${message.id}: ${insertError.message}`);
    return "error";
  }

  existingIdentifiers.set(mediaIdentifier, {
    id: null,
    original_filename: mediaIdentifier,
    source_channel_id: channelLabel,
    source_post_external_id: sourcePostExternalId,
    source_grouped_id: groupedId,
    media_kind: mediaInfo.mediaKind,
    mime_type: mediaInfo.mimeType,
  });
  return "imported";
}
