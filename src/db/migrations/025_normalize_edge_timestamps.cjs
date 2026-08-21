// Repairs edges written straight into the database by a script, bypassing the writer. They
// used SQLite's `datetime('now')`, which returns the right instant in UTC but formats it as
// `YYYY-MM-DD HH:MM:SS` — no `T`, no milliseconds, no `Z`. Every other timestamp in the
// store is ISO-8601, and two things quietly break when one is not:
//
//   - `Date.parse` reads a space-separated timestamp as LOCAL time, so the row is read back
//     skewed by the machine's UTC offset.
//   - a space sorts before `T`, so the row precedes every ISO timestamp of the same day in
//     any comparison done on the string, which is how the ranking layer compares times.
//
// The instant itself is correct, so this is a reformat and not a correction. Idempotent: it
// matches only the malformed shape, and rewritten rows no longer match.
exports.up = function (db) {
  db.prepare(
    `UPDATE edges
        SET valid_from = replace(valid_from, ' ', 'T') || '.000Z'
      WHERE valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
  ).run();

  db.prepare(
    `UPDATE edges
        SET invalidated_at = replace(invalidated_at, ' ', 'T') || '.000Z'
      WHERE invalidated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
  ).run();
};
