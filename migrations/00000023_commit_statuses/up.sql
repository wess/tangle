-- Commit statuses (GitHub-compatible). External CI/CD (e.g. Kettle) posts a
-- state per (sha, context); the combined status rolls these up to drive the
-- green/red checks shown on commits and pull requests.
CREATE TABLE commit_statuses (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  state TEXT NOT NULL,                       -- pending | success | failure | error
  context TEXT NOT NULL DEFAULT 'default',
  description TEXT,
  target_url TEXT,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Latest state per context wins; a re-post of the same context updates in place.
  UNIQUE(repo_id, sha, context)
);

CREATE INDEX idx_commit_statuses_repo_sha ON commit_statuses(repo_id, sha);
