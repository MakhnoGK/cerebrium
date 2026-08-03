import { homedir } from "node:os";
import { join } from "node:path";
import { configSection, custom, int, num, SectionOf, str } from "@/domain/ports/config";

const home = (...parts: string[]): string => join(homedir(), ".cerebrium", ...parts);

@configSection()
export class DatabaseConfig extends SectionOf("database", {
  path: str(home("memory.db")).env("MEMORY_DB_PATH"),
}) {}

@configSection()
export class EmbeddingConfig extends SectionOf("embedding", {
  provider: str("local").env("MEMORY_EMBED_PROVIDER"),
  model: str("Xenova/multilingual-e5-small").env("MEMORY_EMBED_MODEL"),
  cacheDir: str(home("models")).env("MEMORY_MODEL_CACHE"),
  batchSize: int(64).positive().env("MEMORY_EMBED_BATCH"),
}) {}

@configSection()
export class RerankConfig extends SectionOf("rerank", {
  provider: str("off").env("MEMORY_RERANK"),
  model: str("Xenova/ms-marco-MiniLM-L-6-v2").env("MEMORY_RERANK_MODEL"),
  cacheDir: str(home("models")).env("MEMORY_MODEL_CACHE"),
}) {}

// Ranking and write-path policy. These are the knobs that shape what the agent gets back,
// so they are tuned per deployment rather than baked into the retrieval code.
// `dedupThreshold` and `lexicalDedupThreshold` are calibrated, not chosen: run
// `npm run calibrate:report` against a real store and read them off it. They are also
// scale-specific — an embedding-model swap invalidates both. `mmrLambda` at 1.0 is pure
// relevance, i.e. the diversity pass off; `useWeight` at 0 disables the usage prior, which
// is the knob to turn down if retrieval starts feeling stuck on the same nodes.
@configSection()
export class RetrievalConfig extends SectionOf("retrieval", {
  symbolWeight: num(0.5).positive().env("MEMORY_SYMBOL_WEIGHT"),
  mmrLambda: num(0.7).range(0, 1).env("MEMORY_MMR_LAMBDA"),
  useWeight: num(0.25).range(0, 1).env("MEMORY_USE_WEIGHT"),
  dedupThreshold: num(0.92).range(0, 1).env("MEMORY_DEDUP_THRESHOLD"),
  lexicalDedupThreshold: num(0.2).range(0, 1).env("MEMORY_DEDUP_LEXICAL_THRESHOLD"),
  workingSetTokens: int(1500).positive().env("MEMORY_WORKING_SET_TOKENS"),
}) {}

// `idleIntervalMs` is the poll cadence once the queue is empty; `idleExitMs` is how long
// the daemon stays idle before releasing the model and exiting.
@configSection()
export class DaemonConfig extends SectionOf("daemon", {
  activeIntervalMs: int(0).nonNegative().env("MEMORY_DAEMON_ACTIVE_MS"),
  idleIntervalMs: int(5_000).positive(),
  idleExitMs: int(300_000).positive().env("MEMORY_DAEMON_IDLE_MS"),
}) {}

export interface CodeRoot {
  name: string;
  root: string;
}

// MEMORY_CODE_ROOTS = "name=path,name2=path2". Malformed entries are skipped rather than
// failing the parse. These are merged with the roots remembered in the DB by `code_index`;
// this is only the environment half of that merge.
function parseRoots(raw: string): CodeRoot[] | undefined {
  const roots = raw.split(",").reduce<CodeRoot[]>((acc, part) => {
    const eq = part.indexOf("=");

    if (eq < 0) return acc;

    const name = part.slice(0, eq).trim();
    const root = part.slice(eq + 1).trim();

    return name && root ? [...acc, { name, root }] : acc;
  }, []);

  return roots.length ? roots : undefined;
}

@configSection()
export class CodeConfig extends SectionOf("code", {
  roots: custom<CodeRoot[]>([], parseRoots).env("MEMORY_CODE_ROOTS"),
}) {}
