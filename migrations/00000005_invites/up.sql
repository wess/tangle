CREATE TABLE invites (
  id SERIAL PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  email TEXT,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_email ON invites(email);
