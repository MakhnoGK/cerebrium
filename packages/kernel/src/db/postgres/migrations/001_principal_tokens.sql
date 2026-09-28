-- Bearer tokens for the network listener. Only the sha256 of a token is kept, and a
-- revoked token keeps its row.
CREATE TABLE principal_tokens (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX principal_tokens_principal ON principal_tokens (principal_id, created_at);
