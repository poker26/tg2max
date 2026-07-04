import { supabase } from "../db/supabase.js";

function normalizeMessageText(message) {
  return String(message?.text ?? "").trim();
}

export function filterImportableMessages(messages) {
  return (messages ?? []).filter((message) => {
    const hasText = normalizeMessageText(message).length > 0;
    const hasMedia = Boolean(message?.media);
    return hasText || hasMedia;
  });
}

export async function upsertChannelPosts(messages, channelUsername) {
  let savedCount = 0;
  let updatedCount = 0;

  for (const message of messages) {
    const postRecord = {
      external_id: String(message.id),
      channel_id: channelUsername,
      text: normalizeMessageText(message),
      published_at: message.date ? new Date(message.date * 1000).toISOString() : null,
      media_refs: [],
    };

    const { data: existingRow, error: existingError } = await supabase
      .from("channel_posts")
      .select("id, text, published_at")
      .eq("channel_id", channelUsername)
      .eq("external_id", String(message.id))
      .maybeSingle();

    if (existingError) {
      console.error(`Error loading post #${message.id}: ${existingError.message}`);
      continue;
    }

    if (!existingRow) {
      const { error: insertError } = await supabase.from("channel_posts").insert(postRecord);
      if (insertError) {
        console.error(`Error saving post #${message.id}: ${insertError.message}`);
        continue;
      }
      savedCount++;
      continue;
    }

    const textChanged = String(existingRow.text ?? "") !== postRecord.text;
    const publishedAtChanged =
      String(existingRow.published_at ?? "") !== String(postRecord.published_at ?? "");
    if (!textChanged && !publishedAtChanged) {
      continue;
    }

    const { error: updateError } = await supabase
      .from("channel_posts")
      .update({
        text: postRecord.text,
        published_at: postRecord.published_at,
      })
      .eq("id", existingRow.id);

    if (updateError) {
      console.error(`Error updating post #${message.id}: ${updateError.message}`);
      continue;
    }
    updatedCount++;
  }

  return { savedCount, updatedCount };
}
