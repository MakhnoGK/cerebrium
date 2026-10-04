import { z } from "zod";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CODE_INDEX,

  description:
    "Index the owner's source repositories into `symbol` mirror nodes and code edges (defines/imports/calls). Run this " +
    "AFTER pulling or changing a repo. It is kernel-side and incremental: unchanged files are hash-gated and cost nothing, " +
    "changed files re-parse and re-embed only the symbols that changed, and files/symbols removed from source are soft- " +
    "invalidated (never deleted). Pass `repo` (a configured MEMORY_CODE_ROOTS name) or `path` (a directory), or neither to " +
    "index all configured roots; `force:true` re-parses everything. It does NOT read code back to you — it returns only a " +
    "compact per-repo summary (files scanned/indexed/skipped, symbols added/updated/invalidated, edges, timing). To read " +
    "the code afterwards use `search` (by meaning) or `code_lookup` (by structure), then `get` for a symbol's source. " +
    "Against a Cerebrium host, it indexes the git checkout at `path` (default: your working directory) on its current " +
    "branch: only files the host lacks are uploaded, and the host parses them. The first index of a checkout on a " +
    "machine set up with `agent:setup --index-repo` also opts it in: git hooks re-index it after every commit, " +
    "checkout, merge and rewrite, so later calls are only needed for uncommitted work.",

  schema: {
    session_id: sessionIdSchema,
    repo: z
      .string()
      .optional()
      .describe("Name of a configured repo (from MEMORY_CODE_ROOTS). Omit to index all roots."),
    path: z
      .string()
      .optional()
      .describe(
        "Explicit repo-root directory to index instead of a configured name (a checkout, on a Cerebrium host).",
      ),
    force: z
      .boolean()
      .optional()
      .describe("Re-parse every file, bypassing the per-file hash-gate (default false)."),
  },
};
