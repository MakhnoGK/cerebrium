// A user query as the text branch sees it: a list of terms, each one or more words. A
// multi-word term is a phrase. Terms are OR-ed: a memory search favors recall (the ranker
// puts the best matches on top; the agent reads envelopes), and one stray token can't zero
// a query. Quoted phrases in the input are preserved; bare words are split on the same
// boundaries FTS5 tokenizes on. Each backend compiles this into its own query language, so
// no operator in the input can reach one.
export type TextQuery = readonly (readonly string[])[];

const WORD_BOUNDARY = /[^\p{L}\p{N}_]+/u;

// Null when nothing searchable remains.
export function parseTextQuery(raw: string): TextQuery | null {
  const terms: string[][] = [];

  const withoutPhrases = raw.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    const words = phrase.split(WORD_BOUNDARY).filter(Boolean);
    if (words.length) terms.push(words);
    return " ";
  });

  for (const word of withoutPhrases.split(WORD_BOUNDARY)) {
    if (word) terms.push([word]);
  }

  return terms.length ? terms : null;
}

// The FTS5 MATCH expression for a query. Every term is quoted, so FTS5 operators
// (AND/OR/NEAR/*/^/-/:) can't be injected and a malformed query can never throw.
export function toFtsMatch(query: TextQuery): string {
  return query.map((words) => `"${words.join(" ")}"`).join(" OR ");
}
