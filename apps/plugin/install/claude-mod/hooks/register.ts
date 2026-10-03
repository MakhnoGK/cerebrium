import type { EngineInterface as Api, Register } from "claude-code";
import {
  formatAnswer,
  parseSearch,
  reposOf,
  scopeOf,
  textOf,
  type LookupSymbol,
  type Search,
} from "./code-nav.ts";

const SERVER = "cerebrium";
const PREFERRED_TOOLS = /^mcp__cerebrium__(code_lookup|search|get|session_start)$/;

let config: Promise<string[]> | undefined;
const sessions = new Map<string, Promise<string>>();
const answered = new Set<string>();

function indexedRepos($: Api): Promise<string[]> {
  return (config ??= readRepos($).catch(() => []));
}

async function readRepos($: Api): Promise<string[]> {
  const home = (await $.env.get("CEREBRIUM_HOME")) ?? `${await $.env.get("HOME")}/.cerebrium`;
  return reposOf(await $.fs.read(`${home}/plugin-index.json`));
}

function sessionFor($: Api, project: string): Promise<string> {
  const cached = sessions.get(project);
  if (cached) return cached;
  const id = startSession($, project);
  id.catch(() => sessions.delete(project));
  sessions.set(project, id);
  return id;
}

async function startSession($: Api, project: string): Promise<string> {
  const r = await $.mcp.call(SERVER, "session_start", { project });
  const sessionId = (JSON.parse(textOf(r)) as { session_id?: string }).session_id;
  if (r.isError || !sessionId) throw new Error("no session_id");
  return sessionId;
}

async function lookup($: Api, repo: string, name: string): Promise<LookupSymbol[]> {
  const session_id = await sessionFor($, repo);
  const r = await $.mcp.call(SERVER, "code_lookup", { session_id, name, repo, limit: 8 });
  if (r.isError) return [];
  return (JSON.parse(textOf(r)) as { symbols?: LookupSymbol[] }).symbols ?? [];
}

async function answerFromIndex(
  $: Api,
  search: Search,
  key: string,
  again: string,
): Promise<string | undefined> {
  if (answered.has(key)) return undefined;
  const scope = scopeOf(search, await indexedRepos($));
  if (!scope) return undefined;

  const tail = scope.symbol.split(/\.|::|->/).at(-1)!;
  let symbols = await lookup($, scope.repo, scope.symbol).catch(() => []);
  if (!symbols.length && tail !== scope.symbol)
    symbols = await lookup($, scope.repo, tail).catch(() => []);
  if (!symbols.length) return undefined;

  answered.add(key);
  return formatAnswer(scope.symbol, scope.repo, symbols, again);
}

export const register: Register = (on) => {
  config = undefined;
  sessions.clear();
  answered.clear();

  on("tool.describe", { tool: PREFERRED_TOOLS }, async ($, e, next) => ({
    ...(await next(e)),
    isDeferred: false,
  }));

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const search = parseSearch(e.command, await $.session.cwd());
    if (!search) return next(e);
    const deny = await answerFromIndex(
      $,
      search,
      `Bash\0${search.cwd}\0${e.command}`,
      "run the identical command again",
    );
    return deny ? { deny } : next(e);
  });

  on("tool.call", { tool: /^Grep$/ }, async ($, e, next) => {
    const input = e as unknown as { pattern: string; path?: string; glob?: string; type?: string };
    const cwd = await $.session.cwd();
    const search: Search = {
      pattern: input.pattern,
      cwd,
      paths: input.path ? [input.path] : [],
      globs: input.glob ? [input.glob] : [],
      types: input.type ? [input.type] : [],
    };
    const key = ["Grep", cwd, input.pattern, input.path, input.glob, input.type].join("\0");
    const deny = await answerFromIndex($, search, key, "repeat the identical Grep");
    return deny ? { deny } : next(e);
  });
};
