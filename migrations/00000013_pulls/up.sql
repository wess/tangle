CREATE TABLE pulls (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  head_repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  merge_commit_sha TEXT,
  merged_at TIMESTAMPTZ,
  merged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

CREATE INDEX idx_pulls_repo_state ON pulls(repo_id, state);
CREATE INDEX idx_pulls_user ON pulls(user_id);
