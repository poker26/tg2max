import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config.js";

export function createTelegramClient() {
  return new TelegramClient(
    new StringSession(config.telegram.session),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 }
  );
}

export async function withTelegramClient(callback) {
  const client = createTelegramClient();
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.disconnect();
  }
}
