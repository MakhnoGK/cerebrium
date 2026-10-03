-- Every title a node has carried, so a wikilink written against an old title still resolves.
CREATE TABLE IF NOT EXISTS node_titles (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  title TEXT NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (node_id, title)
) STRICT;

INSERT OR IGNORE INTO node_titles (node_id, title, since)
  SELECT id, title, created_at FROM nodes WHERE memory_kind IN ('semantic', 'episodic');

-- A dangling wikilink the owner chose to leave as it is.
CREATE TABLE IF NOT EXISTS wikilink_ignores (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  link TEXT NOT NULL,
  ignored_at TEXT NOT NULL,
  PRIMARY KEY (node_id, link)
) STRICT;
