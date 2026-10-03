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

// Deduplicated by slug, in the order they first appear; `raw` is the text as written.
export function wikilinks(content: string): { raw: string; slug: string }[] {
  const out = new Map<string, string>();

  for (const match of content.matchAll(WIKILINK)) {
    const raw = (match[1] ?? "").trim();
    const slug = slugify(raw);

    if (slug.length && !out.has(slug)) out.set(slug, raw);
  }

  return [...out].map(([slug, raw]) => ({ raw, slug }));
}

export function wikilinkTargets(content: string): string[] {
  return wikilinks(content).map((link) => link.slug);
}

const WIKILINK_TOKEN = /\[\[([^\]]+)\]\]/g;

// Rewrites every `[[link…]]` whose target slugs to `link`'s: onto `target` when given,
// keeping any `#section` and `|label`, or to plain text when not.
export function rewriteWikilink(
  content: string,
  link: string,
  target: string | null,
): { content: string; count: number } {
  const slug = slugify(link);
  let count = 0;

  const rewritten = content.replace(WIKILINK_TOKEN, (token, inner: string) => {
    const pipe = inner.indexOf("|");
    const ref = pipe < 0 ? inner : inner.slice(0, pipe);
    const label = pipe < 0 ? null : inner.slice(pipe + 1);
    const hash = ref.indexOf("#");
    const name = hash < 0 ? ref : ref.slice(0, hash);

    if (slugify(name) !== slug) return token;

    count++;

    if (target === null) return label ?? ref;

    return `[[${target}${hash < 0 ? "" : ref.slice(hash)}${label === null ? "" : `|${label}`}]]`;
  });

  return { content: rewritten, count };
}

const CONTEXT_CHARS = 600;

// The text on either side of the first `[[link…]]` in `content`.
export function wikilinkContext(content: string, link: string): string {
  const at = content.indexOf(`[[${link}`);

  if (at < 0) return "";

  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(content.length, at + link.length + CONTEXT_CHARS);

  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

const NODE_ID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

// A wikilink written as a node id, `[[01M3…]]`, slugified to lower case; null for a title.
export function idTarget(slug: string): string | null {
  return NODE_ID.test(slug) ? slug.toUpperCase() : null;
}

export type SlugIndex = Map<string, string[]>;

export function slugIndexOf(rows: { id: string; title: string }[]): SlugIndex {
  const index: SlugIndex = new Map();

  for (const row of rows) {
    const slug = slugify(row.title);
    const ids = index.get(slug) ?? [];

    if (!ids.includes(row.id)) index.set(slug, [...ids, row.id]);
  }

  return index;
}

export type Resolution =
  | { kind: "exact" | "prefix"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "unknown" };

const AMBIGUOUS_CANDIDATES = 5;

// Exact title match first, then a unique prefix — a truncated slug is the common case and
// an ambiguous one is deliberately left unlinked rather than guessed.
export function resolveTarget(index: SlugIndex, target: string): Resolution {
  const exact = index.get(target);

  if (exact) {
    return exact.length === 1
      ? { kind: "exact", id: exact[0]! }
      : { kind: "ambiguous", ids: exact.slice(0, AMBIGUOUS_CANDIDATES) };
  }

  const found: string[] = [];

  for (const [slug, ids] of index) {
    if (slug.startsWith(target)) found.push(...ids);
  }

  if (found.length === 1) return { kind: "prefix", id: found[0]! };

  return found.length
    ? { kind: "ambiguous", ids: found.slice(0, AMBIGUOUS_CANDIDATES) }
    : { kind: "unknown" };
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
