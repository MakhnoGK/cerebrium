// Wikilinks are how a node's prose names another node: `[[some-node-title-slug]]`. The
// slug is the target's title, lowercased with every run of non-alphanumerics collapsed to
// a hyphen — and usually truncated, because a title can be long.

const WIKILINK = /\[\[([^\]|#]+)/g;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Deduplicated, in the order they first appear.
export function wikilinkTargets(content: string): string[] {
  const out = new Set<string>();

  for (const match of content.matchAll(WIKILINK)) {
    const slug = slugify(match[1] ?? "");

    if (slug.length) out.add(slug);
  }

  return [...out];
}

export type SlugIndex = Map<string, string[]>;

export type Resolution =
  { kind: "exact" | "prefix"; id: string } | { kind: "ambiguous" } | { kind: "unknown" };

// Exact title match first, then a unique prefix — a truncated slug is the common case and
// an ambiguous one is deliberately left unlinked rather than guessed.
export function resolveTarget(index: SlugIndex, target: string): Resolution {
  const exact = index.get(target);

  if (exact) {
    return exact.length === 1 ? { kind: "exact", id: exact[0]! } : { kind: "ambiguous" };
  }

  let found: string | undefined;

  for (const [slug, ids] of index) {
    if (!slug.startsWith(target)) continue;
    if (found !== undefined || ids.length > 1) return { kind: "ambiguous" };

    found = ids[0];
  }

  return found === undefined ? { kind: "unknown" } : { kind: "prefix", id: found };
}

// ---- code citations --------------------------------------------------------
// Prose cites code in backticks. A bare word is not a citation: matching those against a
// symbol index resolves `migration`, `provider` and `different` to whatever happens to
// carry that name.
const CITATION = /`([^`\n]{2,80})`/g;

// A citation may be written `Class.method`, `path/file.ts:Symbol` or `bareName(...)`.
export function citedSymbolNames(content: string): string[] {
  const out = new Set<string>();

  for (const match of content.matchAll(CITATION)) {
    const raw = (match[1] ?? "").trim();
    const tail = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
    const name = tail.includes("(") ? tail.slice(0, tail.indexOf("(")) : tail;

    if (isDistinctive(raw, name)) out.add(name);
  }

  return [...out];
}

// An ordinary lowercase word is a coincidence, not a citation — `stats`, `node`, `install`
// and `vector` are all real symbol names in this repo and none of them was meant as one.
function isDistinctive(raw: string, name: string): boolean {
  return /[a-z0-9][A-Z]/.test(name) || name.includes("_") || /[./:]/.test(raw);
}

// A note is held to its own project's code: exactly the repo of that name, or one of its
// `project-*` siblings.
export function repoBelongsToProject(repo: string, project: string | null): boolean {
  if (project === null) return false;

  return repo === project || repo.startsWith(`${project}-`);
}
