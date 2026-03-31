CREATE TABLE IF NOT EXISTS channel_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  media_refs JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_channel_posts_external UNIQUE (channel_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_posts_channel_published
  ON channel_posts(channel_id, published_at DESC);

CREATE TABLE IF NOT EXISTS media_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'generated')),
  bucket_name TEXT,
  object_key TEXT,
  url TEXT,
  source TEXT CHECK (source IN ('telegram_channel', 'local_upload')),
  original_filename TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_uploads_source ON media_uploads(source);

CREATE TABLE IF NOT EXISTS crosspost_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_post_id UUID NOT NULL REFERENCES channel_posts(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT 'max',
  target_post_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (channel_post_id, target)
);

CREATE INDEX IF NOT EXISTS idx_crosspost_log_status ON crosspost_log(status);
CREATE INDEX IF NOT EXISTS idx_crosspost_log_target ON crosspost_log(target, status);
