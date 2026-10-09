// SQL both backends share verbatim.

// A revision of `r` someone wrote, as opposed to a merge fold or a sweep's wikilink fix.
export const AUTHORED_REVISION = `(r.reason IS NULL OR (r.reason <> 'merge'
  AND r.reason NOT LIKE 'wikilink [[%' AND r.reason NOT LIKE 'unlinked [[%'))`;

// Node `n` unless it is an episodic note a distill has absorbed or one older than
// `@activeSince`.
export const ACTIVE_EPISODIC = `(n.memory_kind <> 'episodic'
  OR (n.consolidated_at IS NULL AND n.valid_from >= @activeSince))`;
