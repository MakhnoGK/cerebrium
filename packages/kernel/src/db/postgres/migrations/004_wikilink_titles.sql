-- Every title a node has carried, so a wikilink written against an old title still resolves.
CREATE TABLE node_titles (
  node_id TEXT NOT NULL REFERENCES nodes (id),
  title   TEXT NOT NULL,
  since   TEXT NOT NULL,
  PRIMARY KEY (node_id, title)
);

INSERT INTO node_titles (node_id, title, since)
  SELECT id, title, created_at FROM nodes WHERE memory_kind IN ('semantic', 'episodic')
  ON CONFLICT DO NOTHING;

-- A dangling wikilink the owner chose to leave as it is.
CREATE TABLE wikilink_ignores (
  node_id    TEXT NOT NULL REFERENCES nodes (id),
  link       TEXT NOT NULL,
  ignored_at TEXT NOT NULL,
  PRIMARY KEY (node_id, link)
);
