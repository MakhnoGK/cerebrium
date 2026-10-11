// SQL both backends share verbatim.

// A revision of `r` someone wrote, as opposed to a merge fold or a sweep's wikilink fix.
export const AUTHORED_REVISION = `(r.reason IS NULL OR (r.reason <> 'merge'
  AND r.reason NOT LIKE 'wikilink [[%' AND r.reason NOT LIKE 'unlinked [[%'))`;

// A revision that changes what `r` says: anything but a sweep's wikilink fix.
export const CLAIM_REVISION = `(r.reason IS NULL
  OR (r.reason NOT LIKE 'wikilink [[%' AND r.reason NOT LIKE 'unlinked [[%'))`;

// A revision of `r` that no later revision reverted past.
export const UNREVERTED_REVISION = `NOT EXISTS (
  SELECT 1 FROM revisions rv
   WHERE rv.node_id = r.node_id AND rv.rev > r.rev AND rv.reverts_rev < r.rev)`;

export const ORIGIN_DEPTH = 3;

// Every principal behind each root's current text: its creator, whoever revised what it
// says, and the same for the nodes it was distilled from or superseded, up to ORIGIN_DEPTH
// hops. The caller defines `roots(id)` first in the same WITH RECURSIVE.
export const ORIGIN_PRINCIPALS = `
  origin(root, id, depth) AS (
    SELECT id, id, 0 FROM roots
    UNION
    SELECT o.root, e.dst, o.depth + 1
      FROM origin o
      JOIN edges e ON e.src = o.id AND e.invalidated_at IS NULL
                  AND e.type IN ('derived_from', 'supersedes')
     WHERE o.depth < ${String(ORIGIN_DEPTH)}
  )
  SELECT o.root AS id, s.principal_id AS principal
    FROM origin o
    JOIN nodes n ON n.id = o.id AND n.memory_kind IN ('semantic', 'episodic')
    JOIN sessions s ON s.id = n.created_by_session
   WHERE s.principal_id IS NOT NULL
  UNION
  SELECT o.root AS id, s.principal_id AS principal
    FROM origin o
    JOIN revisions r ON r.node_id = o.id
    JOIN sessions s ON s.id = r.session_id
   WHERE s.principal_id IS NOT NULL AND ${CLAIM_REVISION} AND ${UNREVERTED_REVISION}`;

export function groupPrincipals(
  rows: { id: string; principal: string }[],
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();

  for (const row of rows)
    grouped.set(row.id, (grouped.get(row.id) ?? new Set()).add(row.principal));

  return grouped;
}

// Node `n` unless it is an episodic note a distill has absorbed or one older than
// `@activeSince`.
export const ACTIVE_EPISODIC = `(n.memory_kind <> 'episodic'
  OR (n.consolidated_at IS NULL AND n.valid_from >= @activeSince))`;
