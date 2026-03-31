ALTER TABLE media_uploads
  ADD COLUMN IF NOT EXISTS source_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS source_post_external_id TEXT,
  ADD COLUMN IF NOT EXISTS source_grouped_id TEXT,
  ADD COLUMN IF NOT EXISTS media_kind TEXT CHECK (media_kind IN ('image', 'video', 'file')),
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;

CREATE INDEX IF NOT EXISTS idx_media_uploads_source_post
  ON media_uploads (source_channel_id, source_post_external_id);

CREATE INDEX IF NOT EXISTS idx_media_uploads_grouped
  ON media_uploads (source_channel_id, source_grouped_id);
