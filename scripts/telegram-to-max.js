#!/usr/bin/env node
import "dotenv/config";
import { execFileSync } from "child_process";
import { config } from "../src/config.js";
import { supabase } from "../src/db/supabase.js";
import { publishToMax, uploadWallPhoto } from "../src/max/api.js";
import { downloadBufferFromMinio } from "../src/minio-client.js";

const cliArgs = process.argv.slice(2);
const skipImport = cliArgs.includes("--skip-import");
const dryRun = cliArgs.includes("--dry-run");
const newestFirst = cliArgs.includes("--newest-first");

const limitFlagIndex = cliArgs.indexOf("--limit");
const publishLimit = limitFlagIndex >= 0 ? parseInt(cliArgs[limitFlagIndex + 1] || "50", 10) : 50;
const channelArg = cliArgs.find((arg) => arg.startsWith("@"));
const sourceChannel = channelArg || config.telegram.sourceChannel;

if (!sourceChannel) {
  console.error("Source channel is required. Pass @channel or set TELEGRAM_SOURCE_CHANNEL.");
  process.exit(1);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runImportStep() {
  console.log("=== Step 1: Importing posts from Telegram ===");
  execFileSync("node", ["scripts/import-channel-posts.js", sourceChannel], { stdio: "inherit" });

  console.log("\n=== Step 2: Importing media from Telegram ===");
  execFileSync("node", ["scripts/import-channel-media.js", sourceChannel], { stdio: "inherit" });
}

async function loadPendingPosts() {
  const { data: allPosts, error: postsError } = await supabase
    .from("channel_posts")
    .select("id, external_id, channel_id, text, published_at, media_refs")
    .eq("channel_id", sourceChannel)
    .order("published_at", { ascending: !newestFirst });

  if (postsError) {
    throw new Error(`Failed to load channel posts: ${postsError.message}`);
  }

  if (!allPosts?.length) {
    return [];
  }

  const postIds = allPosts.map((post) => post.id);
  const { data: existingCrossposts, error: crosspostError } = await supabase
    .from("crosspost_log")
    .select("channel_post_id")
    .eq("target", "max")
    .in("status", ["published", "pending"])
    .in("channel_post_id", postIds);

  if (crosspostError) {
    throw new Error(`Failed to load crosspost log: ${crosspostError.message}`);
  }

  const alreadyCrosspostedIds = new Set((existingCrossposts ?? []).map((row) => row.channel_post_id));
  return allPosts.filter((post) => !alreadyCrosspostedIds.has(post.id));
}

async function findMediaForPost(post) {
  const channelLabel = post.channel_id.replace(/^@/, "");
  const mediaIdentifier = `tg_${channelLabel}_${post.external_id}`;

  const { data: mediaRows } = await supabase
    .from("media_uploads")
    .select("id, bucket_name, object_key, url")
    .eq("original_filename", mediaIdentifier)
    .limit(1);

  return mediaRows?.[0] || null;
}

async function crosspostOne(post) {
  const { data: logEntry, error: insertLogError } = await supabase
    .from("crosspost_log")
    .insert({ channel_post_id: post.id, target: "max", status: "pending" })
    .select("id")
    .single();

  if (insertLogError) {
    if (insertLogError.code === "23505") {
      return { status: "skipped" };
    }
    throw insertLogError;
  }

  try {
    const attachments = [];
    const media = await findMediaForPost(post);

    if (media?.bucket_name && media?.object_key) {
      const photoBuffer = await downloadBufferFromMinio(media.bucket_name, media.object_key);
      const attachment = await uploadWallPhoto(photoBuffer, `${post.external_id}.jpg`);
      attachments.push(attachment);
    }

    const { postId } = await publishToMax({ message: post.text, attachments });

    await supabase
      .from("crosspost_log")
      .update({
        status: "published",
        target_post_id: String(postId),
        published_at: new Date().toISOString(),
      })
      .eq("id", logEntry.id);

    return { status: "published", postId };
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
      console.log(`  [dry-run] Would publish. Has photo: ${Boolean(media)}`);
      skippedCount++;
      continue;
    }

    const result = await crosspostOne(post);
    if (result.status === "published") {
      console.log(`  [ok] Max post #${result.postId}`);
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
