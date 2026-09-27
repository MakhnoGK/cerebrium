CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  chunk_id UNINDEXED, node_id UNINDEXED, text, tokenize='porter unicode61'
);

INSERT INTO chunk_fts (chunk_id, node_id, text)
SELECT id, node_id, text FROM chunks WHERE stale = 0;
