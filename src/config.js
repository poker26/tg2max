import "dotenv/config";

const required = (name) => {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

const optional = (name, defaultValue = "") => process.env[name] ?? defaultValue;

export const config = {
  telegram: {
    apiId: parseInt(required("TG_API_ID"), 10),
    apiHash: required("TG_API_HASH"),
    session: required("TG_SESSION"),
    importLimit: parseInt(optional("TG_IMPORT_LIMIT", "200"), 10),
    sourceChannel: optional("TELEGRAM_SOURCE_CHANNEL"),
  },
  supabase: {
    url: required("SUPABASE_URL"),
    serviceKey: required("SUPABASE_SERVICE_KEY"),
  },
  minio: {
    endpoint: optional("MINIO_ENDPOINT"),
    accessKey: optional("MINIO_ACCESS_KEY"),
    secretKey: optional("MINIO_SECRET_KEY"),
    bucketMedia: optional("MINIO_BUCKET_MEDIA", "tg2max-media"),
  },
  max: {
    botToken: optional("MAX_BOT_TOKEN"),
    targetChatId: optional("MAX_TARGET_CHAT_ID"),
    apiBaseUrl: optional("MAX_API_BASE_URL", "https://platform-api.max.ru"),
    postDelayMs: parseInt(optional("MAX_POST_DELAY_MS", "5000"), 10),
  },
};

export default config;
