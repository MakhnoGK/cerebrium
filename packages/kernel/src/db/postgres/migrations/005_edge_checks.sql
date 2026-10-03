-- When the sweep last confirmed a system link, so a later revision of either end asks again.
CREATE TABLE edge_checks (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  type       TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (src, dst, type)
);
