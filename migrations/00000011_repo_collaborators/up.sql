CREATE TABLE repo_collaborators (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'reader',
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ
);

CREATE INDEX idx_repo_collaborators_repo ON repo_collaborators(repo_id);
CREATE INDEX idx_repo_collaborators_user ON repo_collaborators(user_id);
CREATE UNIQUE INDEX idx_repo_collaborators_unique
  ON repo_collaborators(repo_id, user_id)
  WHERE user_id IS NOT NULL;
