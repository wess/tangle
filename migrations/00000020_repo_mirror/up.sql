ALTER TABLE repos
  ADD COLUMN mirror_url TEXT,
  ADD COLUMN mirror_last_synced_at TIMESTAMPTZ,
  ADD COLUMN mirror_last_error TEXT;

CREATE INDEX idx_repos_mirror_url ON repos(mirror_url) WHERE mirror_url IS NOT NULL;
