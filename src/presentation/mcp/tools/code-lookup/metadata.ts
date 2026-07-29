import { z } from "zod";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CODE_LOOKUP,

  description:
    "Exact structural lookup over indexed code, complementing fuzzy `search`. Use it for 'where is X defined / what does " +
    "it call / what's in this file': pass `name` to resolve a symbol (simple or qualified) or `file` to list a file's " +
    "symbols. Returns compact symbol envelopes with their signature and `defines`/`calls`/`imports` neighbor stubs, so you " +
    "can navigate structure in one call. Envelopes only — fetch a symbol's raw source with `get`. For 'find code about Y' " +
    "(by meaning, no exact name), use `search` with `types:['symbol']` instead.",

  schema: {
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
  },
};
