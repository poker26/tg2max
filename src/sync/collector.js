import { config } from "../config.js";
import { withTelegramClient } from "../telegram/client.js";
import { filterImportableMessages, upsertChannelPosts } from "../telegram/import-posts.js";
import {
  buildGroupAnchorMap,
  classifyMediaMessage,
  importMediaMessage,
  loadAlreadyImportedIdentifiers,
} from "../telegram/import-media.js";
import { buildSourcePayloadHash, buildSyncDedupKey } from "./hash.js";
import {
  enqueueSyncEvent,
  loadActiveMessageMap,
  loadCursor,
  loadMediaRowsForSourcePosts,
  loadMessageMapForSourceMessages,
  updateCursor,
} from "./repository.js";

export function buildPostPayloadForHash({ message, mediaRows }) {
  return {
    sourceMessageId: Number(message.id),
    text: String(message.text ?? "").trim(),
    date: message.date ? new Date(message.date * 1000).toISOString() : null,
    media: (mediaRows ?? []).map((row) => ({
      objectKey: row.object_key,
      mediaKind: row.media_kind,
      mimeType: row.mime_type,
      sourcePostExternalId: row.source_post_external_id,
    })),
  };
}

export async function collectSyncEvents({ sourceChannelId, targetChatId }) {
  const cursor = await loadCursor(sourceChannelId);
  const collectedStats = {
    totalMessages: 0,
    importedPosts: 0,
    updatedPosts: 0,
    importedMedia: 0,
    updatedMedia: 0,
    createEvents: 0,
    updateEvents: 0,
    deleteEvents: 0,
  };

  await withTelegramClient(async (client) => {
    const messages = await client.getMessages(sourceChannelId, { limit: config.sync.pollLimit });
    const importableMessages = filterImportableMessages(messages);
    collectedStats.totalMessages = importableMessages.length;

    const importStats = await upsertChannelPosts(importableMessages, sourceChannelId);
    collectedStats.importedPosts = importStats.savedCount;
    collectedStats.updatedPosts = importStats.updatedCount;

    const mediaMessages = importableMessages.filter((message) => classifyMediaMessage(message).isSupported);
    const existingIdentifiers = await loadAlreadyImportedIdentifiers(sourceChannelId);
    const groupAnchorMap = buildGroupAnchorMap(importableMessages);
    for (const mediaMessage of mediaMessages) {
      const result = await importMediaMessage({
        client,
        message: mediaMessage,
        channelLabel: sourceChannelId,
        existingIdentifiers,
        groupAnchorMap,
      });
      if (result === "imported") collectedStats.importedMedia++;
      if (result === "updated") collectedStats.updatedMedia++;
    }

    const sourceMessageIds = importableMessages.map((message) => Number(message.id));
    const sourcePostExternalIds = sourceMessageIds.map((messageId) => String(messageId));
    const mediaRows = await loadMediaRowsForSourcePosts(sourceChannelId, sourcePostExternalIds);
    const mediaBySourcePostExternalId = new Map();
    for (const mediaRow of mediaRows) {
      const sourcePostExternalId = String(mediaRow.source_post_external_id ?? "");
      if (!mediaBySourcePostExternalId.has(sourcePostExternalId)) {
        mediaBySourcePostExternalId.set(sourcePostExternalId, []);
      }
      mediaBySourcePostExternalId.get(sourcePostExternalId).push(mediaRow);
    }

    const existingMaps = await loadMessageMapForSourceMessages(
      sourceChannelId,
      sourceMessageIds,
      targetChatId
    );
    const mapBySourceMessageId = new Map(
      existingMaps.map((entry) => [Number(entry.source_message_id), entry])
    );

    for (const message of importableMessages) {
      const sourceMessageId = Number(message.id);
      const postPayload = buildPostPayloadForHash({
        message,
        mediaRows: mediaBySourcePostExternalId.get(String(sourceMessageId)) ?? [],
      });
      const payloadHash = buildSourcePayloadHash(postPayload);
      const existingMap = mapBySourceMessageId.get(sourceMessageId);
      const isCreateEvent = !existingMap;
      const isUpdateEvent = Boolean(
        existingMap && existingMap.deleted_at == null && existingMap.last_source_hash !== payloadHash
      );
      if (!isCreateEvent && !isUpdateEvent) continue;

      const eventType = isCreateEvent ? "create" : "update";
      const dedupKey = buildSyncDedupKey({
        sourceChannelId,
        sourceMessageId,
        eventType,
        payloadHash,
      });

      const enqueueResult = await enqueueSyncEvent({
        source_platform: "telegram",
        source_channel_id: sourceChannelId,
        source_message_id: sourceMessageId,
        event_type: eventType,
        payload_hash: payloadHash,
        dedup_key: dedupKey,
        status: "pending",
        next_retry_at: null,
        metadata: { reason: isCreateEvent ? "new_message" : "content_changed" },
      });

      if (!enqueueResult.queued) continue;
      if (eventType === "create") collectedStats.createEvents++;
      if (eventType === "update") collectedStats.updateEvents++;
    }

    if (importableMessages.length > 0) {
      const minFetchedMessageId = Math.min(...sourceMessageIds);
      const activeMaps = await loadActiveMessageMap(sourceChannelId, targetChatId, minFetchedMessageId);
      const seenSourceMessageIds = new Set(sourceMessageIds);

      for (const mappedMessage of activeMaps) {
        const sourceMessageId = Number(mappedMessage.source_message_id);
        if (seenSourceMessageIds.has(sourceMessageId)) continue;
        const payloadHash = buildSourcePayloadHash({
          sourceMessageId,
          deleteMarker: true,
        });
        const dedupKey = buildSyncDedupKey({
          sourceChannelId,
          sourceMessageId,
          eventType: "delete",
          payloadHash,
        });

        const enqueueResult = await enqueueSyncEvent({
          source_platform: "telegram",
          source_channel_id: sourceChannelId,
          source_message_id: sourceMessageId,
          event_type: "delete",
          payload_hash: payloadHash,
          dedup_key: dedupKey,
          status: "pending",
          next_retry_at: null,
          metadata: { reason: "source_message_missing_in_recent_window" },
        });
        if (enqueueResult.queued) {
          collectedStats.deleteEvents++;
        }
      }
    }

    const maxMessageId = sourceMessageIds.length ? Math.max(...sourceMessageIds) : cursor.last_message_id;
    await updateCursor(sourceChannelId, Math.max(Number(cursor.last_message_id ?? 0), maxMessageId));
  });

  return collectedStats;
}
