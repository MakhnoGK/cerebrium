-- The model's pick for a dangling wikilink, judged against one revision of the note.
CREATE TABLE wikilink_verdicts (
  node_id    TEXT NOT NULL REFERENCES nodes (id),
  link       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  target_id  TEXT,
  confidence TEXT NOT NULL,
  reason     TEXT NOT NULL,
  judged_at  TEXT NOT NULL,
  PRIMARY KEY (node_id, link)
);
