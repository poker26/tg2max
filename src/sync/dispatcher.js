import { config } from "../config.js";
import {
  deleteMessageInMaxChat,
  editMessageInMaxChat,
  publishToMaxChat,
  uploadMediaToMax,
} from "../max/api.js";
import { downloadBufferFromMinio } from "../minio-client.js";
import { buildSourcePayloadHash } from "./hash.js";
import {
  claimDueEvents,
  loadMappedMessageBySourceId,
  loadMediaRowsForSourcePosts,
  loadPostsByExternalIds,
  markEventDone,
  markEventFailed,
  markMappedMessageDeleted,
  upsertMessageMap,
} from "./repository.js";

function getMediaKind(mediaRow) {
  if (String(mediaRow?.media_kind ?? "").toLowerCase() === "video") {
    return "video";
  }
  return "image";
}

function extensionFromMimeType(mediaRow, fallbackExtension = "bin") {
  const mimeType = String(mediaRow?.mime_type ?? "").toLowerCase();
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("webm")) return "webm";
  return fallbackExtension;
}

function isNotFoundError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("not_found") || message.includes("not found");
}

function calculateRetryAt(attemptCount) {
  const baseDelay = Math.max(config.sync.retryBaseDelayMs, 500);
  const delayMs = Math.min(baseDelay * 2 ** Math.max(attemptCount - 1, 0), 5 * 60 * 1000);
  return new Date(Date.now() + delayMs).toISOString();
}

async function buildAttachmentsForSourceMessage(sourceChannelId, sourceMessageId) {
  const mediaRows = await loadMediaRowsForSourcePosts(sourceChannelId, [String(sourceMessageId)]);
  const attachments = [];
  for (let mediaIndex = 0; mediaIndex < mediaRows.length; mediaIndex++) {
    const mediaRow = mediaRows[mediaIndex];
    if (!mediaRow?.bucket_name || !mediaRow?.object_key) continue;
    const mediaBuffer = await downloadBufferFromMinio(mediaRow.bucket_name, mediaRow.object_key);
    const mediaKind = getMediaKind(mediaRow);
    const extension = extensionFromMimeType(mediaRow, mediaKind === "video" ? "mp4" : "jpg");
    const uploadToken = await uploadMediaToMax({
      mediaBuffer,
      filename: `${sourceMessageId}-${mediaIndex + 1}.${extension}`,
      mimeType: mediaRow.mime_type,
      mediaKind,
    });
    attachments.push({
      mediaKind,
      token: uploadToken,
    });
  }
  return attachments;
}

async function loadSourcePost(channelId, sourceMessageId) {
  const sourcePosts = await loadPostsByExternalIds(channelId, [String(sourceMessageId)]);
  return sourcePosts[0] ?? null;
}

async function processCreateEvent(syncEvent, targetChatId) {
  const sourcePost = await loadSourcePost(syncEvent.source_channel_id, syncEvent.source_message_id);
  if (!sourcePost) {
    throw new Error(`Source post ${syncEvent.source_message_id} not found for create`);
  }

  const attachments = await buildAttachmentsForSourceMessage(
    syncEvent.source_channel_id,
    syncEvent.source_message_id
  );
  const publishResult = await publishToMaxChat({
    chatId: String(targetChatId),
    message: sourcePost.text,
    attachments,
  });

  const payloadHash = buildSourcePayloadHash({
    sourceMessageId: syncEvent.source_message_id,
    text: sourcePost.text,
    attachments: attachments.map((attachment) => attachment.mediaKind),
  });

  await upsertMessageMap({
    sourceChannelId: syncEvent.source_channel_id,
    sourceMessageId: syncEvent.source_message_id,
    targetChatId,
    targetMessageId: publishResult.messageId,
    lastSourceHash: payloadHash,
  });
}

async function processUpdateEvent(syncEvent, targetChatId) {
  const sourcePost = await loadSourcePost(syncEvent.source_channel_id, syncEvent.source_message_id);
  if (!sourcePost) {
    throw new Error(`Source post ${syncEvent.source_message_id} not found for update`);
  }

  const mappedMessage = await loadMappedMessageBySourceId(
    syncEvent.source_channel_id,
    syncEvent.source_message_id,
    targetChatId
  );
  if (!mappedMessage?.target_message_id) {
    await processCreateEvent(syncEvent, targetChatId);
    return;
  }

  try {
    await editMessageInMaxChat({
      chatId: String(targetChatId),
      messageId: String(mappedMessage.target_message_id),
      message: sourcePost.text,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const attachments = await buildAttachmentsForSourceMessage(
      syncEvent.source_channel_id,
      syncEvent.source_message_id
    );
    const publishResult = await publishToMaxChat({
      chatId: String(targetChatId),
      message: `[обновлено]\n\n${sourcePost.text}`,
      attachments,
    });
    await upsertMessageMap({
      sourceChannelId: syncEvent.source_channel_id,
      sourceMessageId: syncEvent.source_message_id,
      targetChatId,
      targetMessageId: publishResult.messageId,
      lastSourceHash: syncEvent.payload_hash,
    });
    return;
  }

  await upsertMessageMap({
    sourceChannelId: syncEvent.source_channel_id,
    sourceMessageId: syncEvent.source_message_id,
    targetChatId,
    targetMessageId: mappedMessage.target_message_id,
    lastSourceHash: syncEvent.payload_hash,
  });
}

async function processDeleteEvent(syncEvent, targetChatId) {
  const mappedMessage = await loadMappedMessageBySourceId(
    syncEvent.source_channel_id,
    syncEvent.source_message_id,
    targetChatId
  );
  if (!mappedMessage?.target_message_id) {
    await markMappedMessageDeleted(syncEvent.source_channel_id, syncEvent.source_message_id, targetChatId);
    return;
  }

  try {
    await deleteMessageInMaxChat({
      chatId: String(targetChatId),
      messageId: String(mappedMessage.target_message_id),
    });
  } catch (error) {
    if (config.sync.deleteFallbackMode !== "tombstone") {
      throw error;
    }
    await publishToMaxChat({
      chatId: String(targetChatId),
      message: `Пост #${syncEvent.source_message_id} удален в Telegram.`,
    });
  }

  await markMappedMessageDeleted(syncEvent.source_channel_id, syncEvent.source_message_id, targetChatId);
}

async function processSingleEvent(syncEvent, targetChatId) {
  if (syncEvent.event_type === "create") {
    await processCreateEvent(syncEvent, targetChatId);
    return;
  }
  if (syncEvent.event_type === "update") {
    await processUpdateEvent(syncEvent, targetChatId);
    return;
  }
  if (syncEvent.event_type === "delete") {
    await processDeleteEvent(syncEvent, targetChatId);
    return;
  }
  throw new Error(`Unsupported event_type: ${syncEvent.event_type}`);
}

export async function dispatchSyncEvents({ targetChatId }) {
  const dueEvents = await claimDueEvents({
    batchSize: config.sync.eventBatchSize,
    staleProcessingMs: config.sync.staleProcessingMs,
  });
  if (!dueEvents.length) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  for (const syncEvent of dueEvents) {
    try {
      await processSingleEvent(syncEvent, targetChatId);
      await markEventDone(syncEvent.id);
      succeeded++;
    } catch (error) {
      failed++;
      const nextAttemptCount = Number(syncEvent.attempt_count ?? 0) + 1;
      await markEventFailed(syncEvent.id, {
        attemptCount: nextAttemptCount,
        maxAttempts: config.sync.maxAttempts,
        lastError: error?.message ?? String(error),
        retryAt: calculateRetryAt(nextAttemptCount),
      });
    }
  }

  return {
    processed: dueEvents.length,
    succeeded,
    failed,
  };
}
