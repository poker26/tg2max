#!/usr/bin/env node
import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../src/config.js";
import { supabase } from "../src/db/supabase.js";

const cliArgs = process.argv.slice(2);
const channelArg = cliArgs.find((arg) => arg.startsWith("@"));
const sourceChannel = channelArg || config.telegram.sourceChannel;

if (!sourceChannel) {
  console.error("Source channel is required. Pass @channel or set TELEGRAM_SOURCE_CHANNEL.");
  process.exit(1);
}

async function savePostsToSupabase(messages, channelUsername) {
  let savedCount = 0;

  for (const message of messages) {
    const postRecord = {
      external_id: String(message.id),
      channel_id: channelUsername,
      text: message.text,
      published_at: new Date(message.date * 1000).toISOString(),
      media_refs: [],
    };

    const { error } = await supabase
      .from("channel_posts")
      .upsert(postRecord, { onConflict: "channel_id,external_id", ignoreDuplicates: true });

    if (error) {
      console.error(`Error saving post #${message.id}: ${error.message}`);
      continue;
    }

    savedCount++;
  }

  return savedCount;
}

async function main() {
  const client = new TelegramClient(
    new StringSession(config.telegram.session),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 }
  );

  console.log(`Connecting to Telegram and reading posts from ${sourceChannel}...`);
  await client.connect();

  const allMessages = await client.getMessages(sourceChannel, { limit: config.telegram.importLimit });
  const textMessages = allMessages.filter(
    (message) => message.text && message.text.trim().length > 10
  );

  console.log(
    `Found ${textMessages.length} text posts (out of ${allMessages.length} messages).`
  );

  const savedCount = await savePostsToSupabase(textMessages, sourceChannel);
  console.log(`Saved ${savedCount} posts to Supabase.`);

  await client.disconnect();
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
