-- The earlier revision whose text this one restores; the revisions in between no longer
-- count as authors of the node.
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS reverts_rev INTEGER;
