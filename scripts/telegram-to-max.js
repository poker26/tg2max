#!/usr/bin/env node
import "dotenv/config";
import { execFileSync } from "child_process";
import { config } from "../src/config.js";
import { supabase } from "../src/db/supabase.js";
import { getMaxBotMe, publishToMaxChat, uploadMediaToMax } from "../src/max/api.js";
import { downloadBufferFromMinio } from "../src/minio-client.js";

const cliArgs = process.argv.slice(2);
const skipImport = cliArgs.includes("--skip-import");
const dryRun = cliArgs.includes("--dry-run");
const newestFirst = cliArgs.includes("--newest-first");

const limitFlagIndex = cliArgs.indexOf("--limit");
const publishLimit = limitFlagIndex >= 0 ? parseInt(cliArgs[limitFlagIndex + 1] || "50", 10) : 50;
const channelArg = cliArgs.find((arg) => arg.startsWith("@"));
const sourceChannel = channelArg;
const maxChatIdFlagIndex = cliArgs.indexOf("--max-chat-id");
const maxChatIdFromCli = maxChatIdFlagIndex >= 0 ? cliArgs[maxChatIdFlagIndex + 1] : "";
const targetMaxChatId = maxChatIdFromCli || config.max.targetChatId;

if (!sourceChannel) {
  console.error("Source channel is required. Pass @channel.");
  process.exit(1);
}
if (!targetMaxChatId || !/^-?\d+$/.test(String(targetMaxChatId).trim())) {
  console.error("MAX target chat id is required. Set MAX_TARGET_CHAT_ID or pass --max-chat-id <id>.");
  process.exit(1);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldRetrySupabaseError(error) {
  const errorText = String(error?.message || "").toLowerCase();
  return (
    errorText.includes("502") ||
    errorText.includes("bad gateway") ||
    errorText.includes("timed out") ||
    errorText.includes("timeout") ||
    errorText.includes("econnreset") ||
    errorText.includes("service unavailable")
  );
}

async function runWithRetry(operationName, operationFn, { attempts = 4, baseDelayMs = 1500 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operationFn();
    } catch (error) {
      lastError = error;
      if (!shouldRetrySupabaseError(error) || attempt === attempts) {
        break;
      }
      const delayMs = baseDelayMs * attempt;
      console.warn(`[retry] ${operationName} failed (${error.message}). Retry in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function runImportStep() {
  console.log("=== Step 1: Importing posts from Telegram ===");
  execFileSync("node", ["scripts/import-channel-posts.js", sourceChannel], { stdio: "inherit" });

  console.log("\n=== Step 2: Importing media from Telegram ===");
  execFileSync("node", ["scripts/import-channel-media.js", sourceChannel], { stdio: "inherit" });
}

async function loadPendingPosts() {
  const { data: allPosts, error: postsError } = await runWithRetry(
    "load channel_posts",
    async () =>
      await supabase
        .from("channel_posts")
        .select("id, external_id, channel_id, text, published_at, media_refs")
        .eq("channel_id", sourceChannel)
        .order("published_at", { ascending: !newestFirst })
  );

  if (postsError) {
    throw new Error(`Failed to load channel posts: ${postsError.message}`);
  }

  if (!allPosts?.length) {
    return [];
  }

  const { data: mediaRowsForAlbumDetection, error: mediaRowsError } = await runWithRetry(
    "load media rows for album child detection",
    async () =>
      await supabase
        .from("media_uploads")
        .select("original_filename, source_post_external_id")
        .eq("source", "telegram_channel")
        .eq("source_channel_id", sourceChannel)
        .not("source_post_external_id", "is", null)
        .limit(10000)
  );

  if (mediaRowsError) {
    throw new Error(`Failed to load media rows for album detection: ${mediaRowsError.message}`);
  }

  const albumChildExternalIds = new Set();
  for (const mediaRow of mediaRowsForAlbumDetection ?? []) {
    const originalFilename = String(mediaRow.original_filename ?? "");
    const parsedChildExternalId = originalFilename.match(/_(\d+)$/)?.[1] ?? null;
    const anchorExternalId = String(mediaRow.source_post_external_id ?? "").trim();
    if (!parsedChildExternalId || !anchorExternalId) {
      continue;
    }
    if (parsedChildExternalId !== anchorExternalId) {
      albumChildExternalIds.add(parsedChildExternalId);
    }
  }

  const { data: existingCrossposts, error: crosspostError } = await runWithRetry(
    "load crosspost_log",
    async () =>
      await supabase
        .from("crosspost_log")
        .select("channel_post_id")
        .eq("target", "max")
        .in("status", ["published", "pending"])
  );

  if (crosspostError) {
    throw new Error(`Failed to load crosspost log: ${crosspostError.message}`);
  }

  const alreadyCrosspostedIds = new Set((existingCrossposts ?? []).map((row) => row.channel_post_id));
  const filteredPosts = allPosts.filter((post) => {
    if (alreadyCrosspostedIds.has(post.id)) {
      return false;
    }
    if (albumChildExternalIds.has(String(post.external_id))) {
      return false;
    }
    return true;
  });

  if (albumChildExternalIds.size > 0) {
    console.log(`[info] Skipping ${albumChildExternalIds.size} album-child posts to avoid duplicate single-media publishes.`);
  }

  return filteredPosts;
}

async function findMediaForPost(post) {
  const { data: linkedRows, error: linkedError } = await supabase
    .from("media_uploads")
    .select("id, bucket_name, object_key, url, media_kind, mime_type, created_at")
    .eq("source", "telegram_channel")
    .eq("source_channel_id", post.channel_id)
    .eq("source_post_external_id", post.external_id)
    .order("created_at", { ascending: true })
    .limit(12);

  if (!linkedError && linkedRows?.length) {
    return linkedRows;
  }

  const channelLabel = post.channel_id.replace(/^@/, "");
  const mediaIdentifier = `tg_${channelLabel}_${post.external_id}`;
  const { data: fallbackRows } = await supabase
    .from("media_uploads")
    .select("id, bucket_name, object_key, url, created_at")
    .eq("original_filename", mediaIdentifier)
    .limit(1);

  return (fallbackRows ?? []).map((row) => ({
    ...row,
    media_kind: "image",
    mime_type: "image/jpeg",
  }));
}

function mediaKindToUploadKind(mediaRow) {
  if (mediaRow.media_kind === "video") {
    return "video";
  }
  return "image";
}

function fileExtensionFromMediaRow(mediaRow, fallback = "bin") {
  const mimeType = String(mediaRow?.mime_type ?? "").toLowerCase();
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mkv")) return "mkv";

  const objectKey = String(mediaRow?.object_key ?? "");
  const dotIndex = objectKey.lastIndexOf(".");
  if (dotIndex > -1 && dotIndex < objectKey.length - 1) {
    return objectKey.slice(dotIndex + 1);
  }
  return fallback;
}

async function crosspostOne(post) {
  const { data: insertedLogEntry, error: insertLogError } = await supabase
    .from("crosspost_log")
    .insert({ channel_post_id: post.id, target: "max", status: "pending" })
    .select("id")
    .single();

  let logEntry = insertedLogEntry;
  if (insertLogError) {
    if (insertLogError.code !== "23505") {
      throw insertLogError;
    }

    const { data: existingLogEntry, error: existingLogError } = await supabase
      .from("crosspost_log")
      .select("id, status")
      .eq("channel_post_id", post.id)
      .eq("target", "max")
      .maybeSingle();

    if (existingLogError || !existingLogEntry) {
      throw existingLogError || new Error("crosspost_log unique conflict but row not found");
    }

    if (existingLogEntry.status === "published" || existingLogEntry.status === "pending") {
      return { status: "skipped" };
    }

    const { error: resetLogError } = await supabase
      .from("crosspost_log")
      .update({
        status: "pending",
        error_message: null,
        target_post_id: null,
        published_at: null,
      })
      .eq("id", existingLogEntry.id);

    if (resetLogError) {
      throw resetLogError;
    }

    logEntry = { id: existingLogEntry.id };
  }

  try {
    const mediaRows = await findMediaForPost(post);
    const attachments = [];
    let skippedMediaCount = 0;
    for (let mediaIndex = 0; mediaIndex < mediaRows.length; mediaIndex++) {
      const media = mediaRows[mediaIndex];
      if (!media?.bucket_name || !media?.object_key) {
        continue;
      }

      try {
        const mediaBuffer = await downloadBufferFromMinio(media.bucket_name, media.object_key);
        const mediaKind = mediaKindToUploadKind(media);
        const fileExtension = fileExtensionFromMediaRow(media, mediaKind === "video" ? "mp4" : "jpg");
        const mediaToken = await uploadMediaToMax({
          mediaBuffer,
          filename: `${post.external_id}-${mediaIndex + 1}.${fileExtension}`,
          mimeType: media.mime_type,
          mediaKind,
        });
        attachments.push({ mediaKind, token: mediaToken });
      } catch (mediaError) {
        skippedMediaCount++;
        console.warn(
          `  [warn] Skip media ${mediaIndex + 1}/${mediaRows.length} for post #${post.external_id}: ${mediaError.message}`
        );
      }
    }

    if (skippedMediaCount > 0) {
      console.log(`  [info] Post #${post.external_id}: uploaded ${attachments.length}, skipped ${skippedMediaCount}`);
    }

    const result = await publishToMaxChat({
      chatId: String(targetMaxChatId).trim(),
      message: post.text,
      attachments,
    });

    await supabase
      .from("crosspost_log")
      .update({
        status: "published",
        target_post_id: result.messageId != null ? String(result.messageId) : null,
        published_at: new Date().toISOString(),
      })
      .eq("id", logEntry.id);

    return { status: "published", result };
  } catch (error) {
    await supabase
      .from("crosspost_log")
      .update({
        status: "error",
        error_message: error.message?.slice(0, 500),
      })
      .eq("id", logEntry.id);

    return { status: "error", error: error.message };
  }
}

async function main() {
  console.log("Telegram -> Max crosspost pipeline\n");
  const me = await getMaxBotMe();
  console.log(
    `MAX bot connected: user_id=${me?.user_id ?? me?.id ?? "?"}, username=${me?.username ?? "(none)"}`
  );
  console.log(`Target MAX chat: ${targetMaxChatId}\n`);

  if (!skipImport) {
    runImportStep();
    console.log("");
  }

  console.log("=== Step 3: Publishing to Max ===");
  console.log(`Source: ${sourceChannel}`);
  console.log(`Limit: ${publishLimit}, order: ${newestFirst ? "newest" : "oldest"} first`);
  console.log(`Dry run: ${dryRun}\n`);

  const pendingPosts = await loadPendingPosts();
  const postsToProcess = pendingPosts.slice(0, publishLimit);

  if (postsToProcess.length === 0) {
    console.log("Nothing to publish.");
    return;
  }

  let publishedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let index = 0; index < postsToProcess.length; index++) {
    const post = postsToProcess[index];
    const preview = post.text?.slice(0, 80)?.replace(/\n/g, " ") || "(no text)";
    console.log(`[${index + 1}/${postsToProcess.length}] #${post.external_id}: ${preview}...`);

    if (dryRun) {
      const media = await findMediaForPost(post);
      const imageCount = media.filter((item) => item.media_kind !== "video").length;
      const videoCount = media.filter((item) => item.media_kind === "video").length;
      console.log(
        `  [dry-run] Would publish. Media: total=${media.length}, images=${imageCount}, videos=${videoCount}`
      );
      skippedCount++;
      continue;
    }

    const result = await crosspostOne(post);
    if (result.status === "published") {
      console.log(
        `  [ok] Delivered to MAX chat (endpoint: ${result.result.endpoint}, message_id: ${
          result.result.messageId ?? "n/a"
        })`
      );
      publishedCount++;
    } else if (result.status === "error") {
      console.error(`  [error] ${result.error}`);
      errorCount++;
    } else {
      console.log("  [skip] Already in crosspost log");
      skippedCount++;
    }

    if (result.status === "published" && index < postsToProcess.length - 1) {
      await sleep(config.max.postDelayMs);
    }
  }

  console.log("\nDone.");
  console.log(`  Published: ${publishedCount}`);
  console.log(`  Skipped:   ${skippedCount}`);
  console.log(`  Errors:    ${errorCount}`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
