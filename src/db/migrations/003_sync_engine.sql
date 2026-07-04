CREATE TABLE IF NOT EXISTS sync_cursor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_channel_id TEXT NOT NULL UNIQUE,
  last_message_id BIGINT NOT NULL DEFAULT 0,
  last_scan_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_platform TEXT NOT NULL DEFAULT 'telegram',
  source_channel_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  target_platform TEXT NOT NULL DEFAULT 'max',
  target_chat_id TEXT NOT NULL,
  target_message_id TEXT,
  last_source_hash TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_message_map_source UNIQUE (source_platform, source_channel_id, source_message_id, target_platform, target_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_message_map_active
  ON message_map(target_platform, target_chat_id, deleted_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_platform TEXT NOT NULL DEFAULT 'telegram',
  source_channel_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'delete')),
  payload_hash TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_events_pending
  ON sync_events(status, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS sync_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
