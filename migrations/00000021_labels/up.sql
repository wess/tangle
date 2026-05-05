CREATE TABLE labels (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '5E81AC',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, name)
);

CREATE INDEX idx_labels_repo ON labels(repo_id);

CREATE TABLE label_assignments (
  id SERIAL PRIMARY KEY,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(label_id, subject_kind, subject_id)
);

CREATE INDEX idx_label_assignments_subject ON label_assignments(subject_kind, subject_id);
