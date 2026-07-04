import { createHash } from "crypto";

function stableStringify(value) {
  if (value == null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const sortedEntries = Object.entries(value).sort(([leftKey], [rightKey]) =>
      leftKey.localeCompare(rightKey)
    );
    return `{${sortedEntries
      .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildSourcePayloadHash(payload) {
  const hash = createHash("sha256");
  hash.update(stableStringify(payload));
  return hash.digest("hex");
}

export function buildSyncDedupKey({ sourceChannelId, sourceMessageId, eventType, payloadHash }) {
  return `${sourceChannelId}:${sourceMessageId}:${eventType}:${payloadHash}`;
}
