import "reflect-metadata";
import type Database from "better-sqlite3";
import { container } from "tsyringe";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { HintsService, MemoryService } from "@/application/services";
import { DB_TOKEN } from "@/db/repositories/base";
import { estimateTokens } from "@/core/tokens";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// Measures what a cheaper wire encoding would actually buy on THIS store's list-shaped tool
// responses, before changing a contract every consumer parses. Replays the queries from the
// retrieval-outcome log through the real ranking pipeline and encodes each response three
// ways. Read-only: the store is opened through the `cli` role and the session-hint write is
// stubbed out, exactly as `eval-retrieval --db` does.
//
// Not part of `npm test` (it may download an embedding model); run with `npm run eval:encoding`.

const HELP = `
eval-encoding — what a cheaper encoding is worth on real tool responses.

  npm run eval:encoding -- --db PATH [--limit N] [--queries N]

  --db PATH    Store to replay against. Opened READ-ONLY; the run cannot modify it.
  --limit N    Results per search (default 10) — the same knob agents pass.
  --queries N  Cap how many logged queries to replay (default all).
  --show       Print one encoded sample of each form.
  --help       This text.

Encodings compared
  json        JSON.stringify — what ships today.
  no-dup-sum  The same JSON minus a 'summary' that only repeats the 'best_chunk' shipped
              beside it. Costs no consumer anything: the field goes only when another
              field already carries the text.
  trimmed     Also drops 'invalidated' when false and 'project' when null — cheaper, but
              every consumer must then read an absent field as a value.
  toon        Tabular: the shared keys become one header, each result one row of values.
              Wins on uniform arrays; optional fields (best_chunk, section, via) cost it
              empty cells, which is exactly the shape question worth measuring.

Sizes are characters and ~chars/4 tokens (src/core/tokens.ts) — the project's own estimate,
not a tokenizer. A difference of a few percent is inside that error bar; act on tens.
`;

interface Encoded {
  name: string;
  chars: number;
  tokens: number;
  sample: string;
}

type Row = Record<string, unknown>;

// `summary` is derived from the opening of the body and `best_chunk` is a slice of the
// matched chunk, so on a hit whose best chunk IS the opening they are the same sentence
// twice. Measured on its own because it is the one rule that costs no consumer anything:
// it removes a field only when another field already carries it.
function dropDuplicateSummary(row: Row): Row {
  const out: Row = { ...row };
  const summary = typeof out.summary === "string" ? out.summary : "";
  const chunk = typeof out.best_chunk === "string" ? out.best_chunk : "";
  const shorter = summary.length <= chunk.length ? summary : chunk;
  const longer = summary.length <= chunk.length ? chunk : summary;

  if (shorter.length > 0 && longer.startsWith(shorter.replace(/…$/, ""))) {
    delete out.summary;
  }

  return out;
}

// The fuller rule: also drop fields whose absence a reader has to interpret. Kept separate
// because every consumer of an envelope — including the UI in the sibling repo — would have
// to read a missing `invalidated` as false.
function trim(row: Row): Row {
  const out = dropDuplicateSummary(row);

  if (out.invalidated === false) delete out.invalidated;
  if (out.project === null) delete out.project;

  return out;
}

// Minimal TOON-shaped encoder for an array of flat objects: one header naming the union of
// keys, one line per row, missing values empty. Nested values fall back to JSON in-cell.
function toon(name: string, rows: Row[]): string {
  if (!rows.length) return `${name}[0]:`;

  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown): string => {
    if (v === undefined || v === null) return "";

    const s = typeof v === "string" ? v : JSON.stringify(v);

    return /[,\n]/.test(s) ? JSON.stringify(s) : s;
  };

  return [
    `${name}[${rows.length}]{${keys.join(",")}}:`,
    ...rows.map((r) => `  ${keys.map((k) => cell(r[k])).join(",")}`),
  ].join("\n");
}

function encodings(name: string, rows: Row[]): Encoded[] {
  const forms: { name: string; text: string }[] = [
    { name: "json", text: JSON.stringify({ [name]: rows }) },
    { name: "no-dup-sum", text: JSON.stringify({ [name]: rows.map(dropDuplicateSummary) }) },
    { name: "trimmed", text: JSON.stringify({ [name]: rows.map(trim) }) },
    { name: "toon", text: toon(name, rows) },
  ];

  return forms.map((f) => ({
    name: f.name,
    chars: f.text.length,
    tokens: estimateTokens(f.text),
    sample: f.text,
  }));
}

// The queries the log actually carries, most recent first, deduplicated.
function loggedQueries(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT detail FROM events
       WHERE action = 'search' AND detail LIKE '%"query"%'
       ORDER BY ts DESC, id DESC`,
    )
    .all() as { detail: string }[];

  const seen = new Set<string>();

  for (const row of rows) {
    try {
      const { query } = JSON.parse(row.detail) as { query?: unknown };

      if (typeof query === "string" && query.trim()) seen.add(query);
    } catch {
      continue;
    }
  }

  return [...seen];
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i < 0 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    console.log(HELP);
    return;
  }

  const store = flag(argv, "--db");

  if (!store) {
    console.log("eval-encoding needs a real store: --db PATH. See --help.");
    return;
  }

  const limit = Number(flag(argv, "--limit") ?? 10);
  const cap = Number(flag(argv, "--queries") ?? Number.POSITIVE_INFINITY);

  const root = buildContainer({
    role: "cli",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_DB_PATH: store }),
      new EnvConfigSource(),
    ),
    into: container.createChildContainer(),
  });

  // Same read-only discipline as eval-retrieval: no session row, no events row.
  root.register(HintsService, {
    useValue: { getUnknownSessionHints: () => Promise.resolve([]) } as unknown as HintsService,
  });

  const db = root.resolve<Database.Database>(DB_TOKEN);
  const provider = root.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);
  const queries = loggedQueries(db).slice(0, cap);

  console.log(`store: ${store} (read-only)`);
  console.log(`embeddings: ${provider.name}`);
  console.log(`replaying ${queries.length} logged queries at limit ${limit}\n`);

  if (!queries.length) {
    console.log("No logged searches carry a query yet; nothing to measure.");
    return;
  }

  const search = root.resolve(SearchTool);
  const totals = new Map<string, { chars: number; tokens: number }>();
  const samples = new Map<string, string>();
  let results = 0;

  for (const query of queries) {
    const res = await search.invoke({ session_id: "encoding-readonly", query, limit });

    results += res.results.length;

    for (const enc of encodings("results", res.results as unknown as Row[])) {
      const acc = totals.get(enc.name) ?? { chars: 0, tokens: 0 };

      totals.set(enc.name, { chars: acc.chars + enc.chars, tokens: acc.tokens + enc.tokens });

      if (!samples.has(enc.name)) samples.set(enc.name, enc.sample);
    }
  }

  // The working set is the other list-shaped payload, and the one every session pays for.
  // Read through the service, not `session_start` — the tool mints a session row, which a
  // read-only run must not do.
  const set = root.resolve(MemoryService).getWorkingSet(undefined) as unknown as {
    semantic?: Row[];
    recent?: Row[];
    tasks?: Row[];
  };
  const workingRows = [...(set.semantic ?? set.recent ?? []), ...(set.tasks ?? [])];

  const base = totals.get("json")!;

  console.log(`search responses: ${queries.length} queries, ${results} results total`);
  console.log("encoding   | chars   | ~tokens | vs json");
  console.log("-----------+---------+---------+--------");

  for (const [name, t] of totals) {
    const delta = ((t.tokens / base.tokens - 1) * 100).toFixed(1);

    console.log(
      `${name.padEnd(10)} | ${String(t.chars).padStart(7)} | ${String(t.tokens).padStart(7)} | ${
        name === "json" ? "     —" : `${delta.padStart(5)}%`
      }`,
    );
  }

  console.log(`\nsession_start working set: ${workingRows.length} envelopes`);
  console.log("encoding   | chars   | ~tokens | vs json");
  console.log("-----------+---------+---------+--------");

  const wbase = encodings("working_set", workingRows).find((e) => e.name === "json")!;

  for (const enc of encodings("working_set", workingRows)) {
    const delta = ((enc.tokens / wbase.tokens - 1) * 100).toFixed(1);

    console.log(
      `${enc.name.padEnd(10)} | ${String(enc.chars).padStart(7)} | ${String(enc.tokens).padStart(7)} | ${
        enc.name === "json" ? "     —" : `${delta.padStart(5)}%`
      }`,
    );
  }

  if (argv.includes("--show")) {
    for (const [name, sample] of samples) {
      console.log(`\n--- ${name} ---\n${sample.slice(0, 1200)}`);
    }
  }

  console.log(
    `\nRead these as a decision, not a score. A contract every consumer parses is worth changing\n` +
      `only for a margin well outside the chars/4 error bar, and the rules are not equally cheap:\n` +
      `'no-dup-sum' costs nothing, 'trimmed' makes every reader interpret an absent field, and\n` +
      `'toon' changes the wire format for every tool at once.`,
  );
}

await main();
