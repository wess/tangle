ALTER TABLE repos
  DROP COLUMN mirror_url,
  DROP COLUMN mirror_last_synced_at,
  DROP COLUMN mirror_last_error;
