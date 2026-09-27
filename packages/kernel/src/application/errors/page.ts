// A client handed back a cursor this build did not issue, or issued for a different
// ordering. Distinguishable so the delivery layer can answer "bad request" rather than
// "internal error" — the caller can fix this by starting again without a cursor.
export class InvalidCursorError extends Error {
  constructor(message = "cursor is not valid for this query; start again without one") {
    super(message);
    this.name = "InvalidCursorError";
  }
}
