const INDEXED_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "php",
  "rs",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "lua",
]);
const INDEXED_TYPES = new Set([
  "ts",
  "typescript",
  "js",
  "javascript",
  "php",
  "rust",
  "c",
  "cpp",
  "lua",
]);
const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|impl|local\s+function)\s+/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)?$/;
const SEARCH_PROGRAM = /^(?:rtk\s+)?(rg|ag|ack|git\s+grep|grep)(?:\s|$)/;
const VALUE_FLAGS = new Set([
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "-d",
  "--max-depth",
  "-f",
  "--file",
  "-e",
  "--regexp",
  "--include",
  "--exclude",
  "--exclude-dir",
  "-M",
  "--max-columns",
]);

export interface Search {
  pattern: string;
  cwd: string;
  paths: string[];
  globs: string[];
  types: string[];
}

export interface LookupSymbol {
  id: string;
  title: string;
  signature?: string;
  path?: string;
  start_line?: number;
  end_line?: number;
  branch?: string;
  neighbors?: { title: string; edge: string; direction: string }[];
}

export function symbolOf(pattern: string): string | undefined {
  let p = pattern
    .trim()
    .replace(/\\b|\\<|\\>/g, "")
    .replace(/^\^/, "")
    .replace(/\$$/, "");
  p = p
    .replace(/\\s[*+]?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const declared = DECLARATION.test(p);
  p = p.replace(DECLARATION, "");
  const called = /(?:\\\(|\()$/.test(p);
  p = p
    .replace(/\s*(?:\\\(|\()$/, "")
    .replace(/\\\./g, ".")
    .trim();
  if (p.length < 3 || !IDENTIFIER.test(p)) return undefined;
  const qualified = /\.|::|->/.test(p);
  const codeShaped = /^[A-Z]/.test(p) || /[A-Z_$]/.test(p.slice(1));
  return declared || called || qualified || codeShaped ? p : undefined;
}

export function extensionOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

export function globIsIndexed(glob: string): boolean {
  if (glob.startsWith("!")) return true;
  const exts = [...glob.matchAll(/\.(\{[^}]*\}|\w+)(?=$|[\s,}])/g)].flatMap((m) =>
    m[1]!.replace(/[{}]/g, "").split(","),
  );
  return exts.length === 0 || exts.some((x) => INDEXED_EXT.has(x.trim().toLowerCase()));
}

export function resolvePath(cwd: string, path: string | undefined): string {
  if (!path) return cwd.replace(/\/+$/, "");
  const url = new URL(
    path.startsWith("/") ? `file://${path}` : path,
    `file://${cwd.replace(/\/+$/, "")}/`,
  );
  return decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
}

export function repoFor(repos: readonly string[], target: string): string | undefined {
  return repos
    .filter((r) => target === r || target.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
}

export function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (quote === '"' && (c === "$" || c === "`")) return undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command.charAt(++i);
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command.charAt(++i);
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else if (c === ">" || c === "<") {
      if (started && !/^\d+$/.test(word)) words.push(word);
      return quote ? undefined : words;
    } else if ("$`(){}".includes(c)) {
      return undefined;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

export function parseSearch(command: string, sessionCwd: string): Search | undefined {
  let cwd = sessionCwd;
  for (const raw of command.split(/&&|\|\||;/)) {
    const segment = raw.split("|")[0]!.trim();
    const cd = /^cd\s+(\S+)$/.exec(segment);
    if (cd) {
      cwd = resolvePath(cwd, cd[1]!.replace(/^['"]|['"]$/g, ""));
      continue;
    }
    const program = SEARCH_PROGRAM.exec(segment);
    if (!program) continue;
    const words = shellWords(segment.slice(program[0].length));
    if (!words) return undefined;
    const isGrep = program[1] === "grep";
    const positional: string[] = [];
    const globs: string[] = [];
    const types: string[] = [];
    let pattern: string | undefined;
    let recursive = !isGrep;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === "--") {
        positional.push(...words.slice(i + 1));
        break;
      }
      if (!w.startsWith("-") || w === "-") {
        positional.push(w);
        continue;
      }
      const eq = w.startsWith("--") ? w.indexOf("=") : -1;
      const flag = eq > 0 ? w.slice(0, eq) : w;
      if (isGrep && (/^-[a-zA-Z]*[rR]/.test(flag) || flag === "--recursive")) recursive = true;
      if (!VALUE_FLAGS.has(flag)) continue;
      const value = eq > 0 ? w.slice(eq + 1) : words[++i];
      if (value === undefined || flag === "-f" || flag === "--file") return undefined;
      if (flag === "-e" || flag === "--regexp") pattern ??= value;
      else if (flag === "-g" || flag === "--glob" || flag === "--include") globs.push(value);
      else if (flag === "-t" || flag === "--type") types.push(value);
    }
    if (!recursive) return undefined;
    pattern ??= positional.shift();
    return pattern === undefined ? undefined : { pattern, cwd, paths: positional, globs, types };
  }
  return undefined;
}

export function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

export function formatAnswer(
  symbol: string,
  repo: string,
  symbols: LookupSymbol[],
  again: string,
): string {
  const branch = symbols.find((s) => s.branch)?.branch;
  const lines = symbols.map((s) => {
    const where = s.path ? `${s.path}:${s.start_line ?? "?"}-${s.end_line ?? "?"}` : s.title;
    const callers = (s.neighbors ?? [])
      .filter((n) => n.edge === "calls" && n.direction === "in")
      .slice(0, 5);
    const head = `- ${s.signature ?? s.title} — ${where} (id ${s.id})`;
    return callers.length
      ? `${head}\n  called by: ${callers.map((c) => c.title).join(", ")}`
      : head;
  });
  return [
    `The search for \`${symbol}\` was answered from the Cerebrium code index (repo ${repo}${branch ? `, branch ${branch}` : ""}) instead of scanning files:`,
    ...lines,
    "",
    "Read a symbol with mcp__cerebrium__get (ids above) or Read at those lines; mcp__cerebrium__code_lookup shows its calls and imports.",
    `For raw text matches (every usage, strings, comments), ${again} and it will go through.`,
  ].join("\n");
}

export interface Scope {
  symbol: string;
  repo: string;
}

export function scopeOf(search: Search, repos: readonly string[]): Scope | undefined {
  const symbol = symbolOf(search.pattern);
  if (!symbol) return undefined;
  if (search.types.some((t) => !INDEXED_TYPES.has(t))) return undefined;
  if (search.globs.length && !search.globs.some(globIsIndexed)) return undefined;

  const targets = (search.paths.length ? search.paths : [undefined]).map((p) =>
    resolvePath(search.cwd, p),
  );
  const foreign = targets.some((t) => {
    const ext = extensionOf(t);
    return ext !== undefined && !INDEXED_EXT.has(ext);
  });
  if (foreign) return undefined;

  const repoPath = repoFor(repos, targets[0]!);
  if (!repoPath || targets.some((t) => repoFor(repos, t) !== repoPath)) return undefined;
  return { symbol, repo: repoPath.slice(repoPath.lastIndexOf("/") + 1) };
}

export function reposOf(configText: string): string[] {
  const parsed = JSON.parse(configText) as { repos?: unknown };
  return Array.isArray(parsed.repos)
    ? parsed.repos
        .filter((r): r is string => typeof r === "string")
        .map((r) => r.replace(/\/+$/, ""))
    : [];
}
