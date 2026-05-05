CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_subject ON comments(subject_kind, subject_id);
CREATE INDEX idx_comments_user ON comments(user_id);
