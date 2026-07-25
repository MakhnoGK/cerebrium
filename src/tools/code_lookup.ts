import { TypeOf, z, ZodObject } from "zod";
import type { Ctx } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import type { SymbolLookup } from "@/db/repo";
import { AbstractTool, ToolName } from "@/tools/contracts";

export class CodeLookupTool extends AbstractTool {
  name = ToolName.CODE_LOOKUP;

  description =
    "Exact structural lookup over indexed code, complementing fuzzy `search`. Use it for 'where is X defined / what does " +
    "it call / what's in this file': pass `name` to resolve a symbol (simple or qualified) or `file` to list a file's " +
    "symbols. Returns compact symbol envelopes with their signature and `defines`/`calls`/`imports` neighbor stubs, so you " +
    "can navigate structure in one call. Envelopes only — fetch a symbol's raw source with `get`. For 'find code about Y' " +
    "(by meaning, no exact name), use `search` with `types:['symbol']` instead.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    name: z
      .string()
      .optional()
      .describe(
        "Resolve a symbol by simple name ('AuthService') or qualified name ('auth/auth.service.ts:AuthService.validate').",
      ),
    file: z
      .string()
      .optional()
      .describe("List the symbols defined in a file (exact repo-relative path or a path suffix)."),
    repo: z.string().optional().describe("Scope to one indexed repo; omit to search across all."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Max symbols to return (default 10, max 25)."),
  };

  protected async invoke(ctx: Ctx, args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown> {
    const hints = touchOrCreate(ctx, args.session_id);

    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    const found = args.name
      ? ctx.repo.findSymbolsByName(args.name, args.repo, args.limit)
      : ctx.repo.findSymbolsInFile(args.repo, args.file!, args.limit);

    ctx.repo.logEvent(
      "code_lookup",
      args.session_id,
      null,
      { name: args.name ?? null, file: args.file ?? null, hits: found.length },
      ctx.now(),
    );

    const out: Record<string, unknown> = { symbols: found.map(present) };

    if (hints.length) out.hints = hints;

    return out;
  }
}

function present(s: SymbolLookup): Record<string, unknown> {
  return {
    ...s.envelope,
    symbol_kind: s.facets.symbol_kind,
    signature: s.facets.signature,
    repo: s.facets.repo,
    path: s.facets.path,
    start_line: s.facets.start_line,
    end_line: s.facets.end_line,
    neighbors: s.neighbors,
  };
}
