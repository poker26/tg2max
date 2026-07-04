import { supabase } from "../db/supabase.js";

const SOURCE_PLATFORM = "telegram";
const TARGET_PLATFORM = "max";

export async function loadCursor(channelId) {
  const { data, error } = await supabase
    .from("sync_cursor")
    .select("id, source_channel_id, last_message_id, last_scan_at")
    .eq("source_channel_id", channelId)
    .maybeSingle();
  if (error) throw new Error(`sync_cursor select failed: ${error.message}`);
  if (data) return data;

  const { data: inserted, error: insertError } = await supabase
    .from("sync_cursor")
    .insert({
      source_channel_id: channelId,
      last_message_id: 0,
      last_scan_at: new Date().toISOString(),
    })
    .select("id, source_channel_id, last_message_id, last_scan_at")
    .single();
  if (insertError) throw new Error(`sync_cursor insert failed: ${insertError.message}`);
  return inserted;
}

export async function updateCursor(channelId, lastMessageId) {
  const { error } = await supabase
    .from("sync_cursor")
    .update({
      last_message_id: lastMessageId,
      last_scan_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("source_channel_id", channelId);
  if (error) throw new Error(`sync_cursor update failed: ${error.message}`);
}

export async function loadPostsByExternalIds(channelId, externalIds) {
  if (!externalIds.length) return [];
  const { data, error } = await supabase
    .from("channel_posts")
    .select("id, external_id, channel_id, text, published_at")
    .eq("channel_id", channelId)
    .in("external_id", externalIds);
  if (error) throw new Error(`channel_posts select failed: ${error.message}`);
  return data ?? [];
}

export async function loadMediaRowsForSourcePosts(channelId, sourcePostExternalIds) {
  if (!sourcePostExternalIds.length) return [];
  const { data, error } = await supabase
    .from("media_uploads")
    .select("id, bucket_name, object_key, media_kind, mime_type, source_post_external_id, created_at")
    .eq("source", "telegram_channel")
    .eq("source_channel_id", channelId)
    .in("source_post_external_id", sourcePostExternalIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`media_uploads select failed: ${error.message}`);
  return data ?? [];
}

export async function loadMessageMapForSourceMessages(channelId, sourceMessageIds, targetChatId) {
  if (!sourceMessageIds.length) return [];
  const { data, error } = await supabase
    .from("message_map")
    .select(
      "id, source_message_id, target_message_id, target_chat_id, last_source_hash, deleted_at, updated_at"
    )
    .eq("source_platform", SOURCE_PLATFORM)
    .eq("target_platform", TARGET_PLATFORM)
    .eq("source_channel_id", channelId)
    .eq("target_chat_id", String(targetChatId))
    .in("source_message_id", sourceMessageIds);
  if (error) throw new Error(`message_map select failed: ${error.message}`);
  return data ?? [];
}

export async function loadActiveMessageMap(channelId, targetChatId, minSourceMessageId = 0) {
  const { data, error } = await supabase
    .from("message_map")
    .select("id, source_message_id, target_message_id, last_source_hash, deleted_at")
    .eq("source_platform", SOURCE_PLATFORM)
    .eq("target_platform", TARGET_PLATFORM)
    .eq("source_channel_id", channelId)
    .eq("target_chat_id", String(targetChatId))
    .is("deleted_at", null)
    .gte("source_message_id", minSourceMessageId);
  if (error) throw new Error(`message_map active select failed: ${error.message}`);
  return data ?? [];
}

export async function enqueueSyncEvent(eventRecord) {
  const { error } = await supabase.from("sync_events").insert(eventRecord);
  if (!error) return { queued: true };
  if (error.code === "23505") return { queued: false };
  throw new Error(`sync_events insert failed: ${error.message}`);
}

export async function claimDueEvents({ batchSize, staleProcessingMs }) {
  const now = new Date();
  const staleProcessingThreshold = new Date(now.getTime() - staleProcessingMs).toISOString();
  const { data: pendingRows, error: pendingError } = await supabase
    .from("sync_events")
    .select(
      "id, source_channel_id, source_message_id, event_type, payload_hash, dedup_key, attempt_count, metadata, created_at"
    )
    .eq("status", "pending")
    .or(`next_retry_at.is.null,next_retry_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(batchSize);
  if (pendingError) throw new Error(`sync_events pending select failed: ${pendingError.message}`);

  const remainingCapacity = Math.max(batchSize - (pendingRows?.length ?? 0), 0);
  let staleRows = [];
  if (remainingCapacity > 0) {
    const { data, error } = await supabase
      .from("sync_events")
      .select(
        "id, source_channel_id, source_message_id, event_type, payload_hash, dedup_key, attempt_count, metadata, created_at"
      )
      .eq("status", "processing")
      .lte("processing_started_at", staleProcessingThreshold)
      .order("created_at", { ascending: true })
      .limit(remainingCapacity);
    if (error) throw new Error(`sync_events stale select failed: ${error.message}`);
    staleRows = data ?? [];
  }

  const rowsToClaim = [...(pendingRows ?? []), ...staleRows];

  const claimedEvents = [];
  for (const eventRow of rowsToClaim) {
    const { data: updatedRows, error: updateError } = await supabase
      .from("sync_events")
      .update({
        status: "processing",
        processing_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventRow.id)
      .in("status", ["pending", "processing"])
      .select("id");

    if (updateError) {
      throw new Error(`sync_events claim update failed: ${updateError.message}`);
    }
    if (updatedRows?.length) {
      claimedEvents.push(eventRow);
    }
  }
  return claimedEvents;
}

export async function markEventDone(eventId) {
  const { error } = await supabase
    .from("sync_events")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", eventId);
  if (error) throw new Error(`sync_events done update failed: ${error.message}`);
}

export async function markEventFailed(eventId, { attemptCount, maxAttempts, lastError, retryAt }) {
  const nextStatus = attemptCount >= maxAttempts ? "error" : "pending";
  const { error } = await supabase
    .from("sync_events")
    .update({
      status: nextStatus,
      attempt_count: attemptCount,
      next_retry_at: nextStatus === "pending" ? retryAt : null,
      last_error: String(lastError ?? "").slice(0, 1000),
      processing_started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId);
  if (error) throw new Error(`sync_events failed update failed: ${error.message}`);
}

export async function upsertMessageMap({
  sourceChannelId,
  sourceMessageId,
  targetChatId,
  targetMessageId,
  lastSourceHash,
  deletedAt = null,
}) {
  const payload = {
    source_platform: SOURCE_PLATFORM,
    source_channel_id: sourceChannelId,
    source_message_id: sourceMessageId,
    target_platform: TARGET_PLATFORM,
    target_chat_id: String(targetChatId),
    target_message_id: targetMessageId ? String(targetMessageId) : null,
    last_source_hash: lastSourceHash,
    last_seen_at: new Date().toISOString(),
    deleted_at: deletedAt,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("message_map")
    .upsert(payload, {
      onConflict:
        "source_platform,source_channel_id,source_message_id,target_platform,target_chat_id",
      ignoreDuplicates: false,
    });
  if (error) throw new Error(`message_map upsert failed: ${error.message}`);
}

export async function loadMappedMessageBySourceId(channelId, sourceMessageId, targetChatId) {
  const { data, error } = await supabase
    .from("message_map")
    .select(
      "id, source_message_id, target_message_id, target_chat_id, last_source_hash, deleted_at, updated_at"
    )
    .eq("source_platform", SOURCE_PLATFORM)
    .eq("target_platform", TARGET_PLATFORM)
    .eq("source_channel_id", channelId)
    .eq("target_chat_id", String(targetChatId))
    .eq("source_message_id", sourceMessageId)
    .maybeSingle();
  if (error) throw new Error(`message_map lookup failed: ${error.message}`);
  return data;
}

export async function markMappedMessageDeleted(channelId, sourceMessageId, targetChatId) {
  const { error } = await supabase
    .from("message_map")
    .update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("source_platform", SOURCE_PLATFORM)
    .eq("target_platform", TARGET_PLATFORM)
    .eq("source_channel_id", channelId)
    .eq("target_chat_id", String(targetChatId))
    .eq("source_message_id", sourceMessageId);
  if (error) throw new Error(`message_map delete mark failed: ${error.message}`);
}

export async function acquireDistributedLock({ lockName, ownerId, ttlMs }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const { data: existingRow, error: existingError } = await supabase
    .from("sync_locks")
    .select("lock_name, owner_id, expires_at")
    .eq("lock_name", lockName)
    .maybeSingle();
  if (existingError) throw new Error(`sync_locks read failed: ${existingError.message}`);

  if (!existingRow) {
    const { error: insertError } = await supabase.from("sync_locks").insert({
      lock_name: lockName,
      owner_id: ownerId,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });
    if (!insertError) return true;
    if (insertError.code !== "23505") {
      throw new Error(`sync_locks insert failed: ${insertError.message}`);
    }
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from("sync_locks")
    .update({
      owner_id: ownerId,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("lock_name", lockName)
    .or(`expires_at.lt.${now.toISOString()},owner_id.eq.${ownerId}`)
    .select("lock_name");
  if (updateError) throw new Error(`sync_locks update failed: ${updateError.message}`);
  return Boolean(updatedRows?.length);
}

export async function releaseDistributedLock({ lockName, ownerId }) {
  const { error } = await supabase
    .from("sync_locks")
    .delete()
    .eq("lock_name", lockName)
    .eq("owner_id", ownerId);
  if (error) throw new Error(`sync_locks release failed: ${error.message}`);
}
