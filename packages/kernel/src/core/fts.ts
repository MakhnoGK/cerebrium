// Turn an arbitrary user query into a safe FTS5 MATCH expression. Every term is
// quoted so FTS5 operators (AND/OR/NEAR/*/^/-/:) can't be injected and a
// malformed query can never throw. Quoted phrases in the input are preserved as
// phrase queries; bare words are split on the same boundaries FTS5 tokenizes on.
// Terms are OR-ed: a memory search favors recall (bm25 ranks the best matches to
// the top; the agent reads envelopes), and one stray token can't zero a query.
// Returns null when nothing searchable remains.
export function toFtsMatch(raw: string): string | null {
  const terms: string[] = [];

  const withoutPhrases = raw.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    const words = phrase.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    if (words.length) terms.push(`"${words.join(" ")}"`);
    return " ";
  });

  for (const word of withoutPhrases.split(/[^\p{L}\p{N}_]+/u)) {
    if (word) terms.push(`"${word}"`);
  }

  return terms.length ? terms.join(" OR ") : null;
}
