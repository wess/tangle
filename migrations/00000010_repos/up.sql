CREATE TABLE repos (
  id SERIAL PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_private BOOLEAN NOT NULL DEFAULT TRUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_template BOOLEAN NOT NULL DEFAULT FALSE,
  fork_of INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  star_count INTEGER NOT NULL DEFAULT 0,
  pushed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_login, name)
);

CREATE INDEX idx_repos_owner ON repos(owner_kind, owner_id);
CREATE INDEX idx_repos_pushed_at ON repos(pushed_at);
CREATE INDEX idx_repos_deleted_at ON repos(deleted_at);
