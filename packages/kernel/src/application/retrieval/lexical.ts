export function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;

  return inter / (a.size + b.size - inter);
}
