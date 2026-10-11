import { z } from "zod";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CODE_INDEX,

  description:
    "Index a git checkout into the host's per-branch code index: symbols and their defines/imports/calls edges, kept " +
    "per branch. It indexes the checkout at `path` (default: your working directory) on its current branch; only " +
    "files the host lacks are uploaded, the host parses them, and unchanged contents cost nothing. It does NOT read " +
    "code back to you — it returns a compact summary (files listed, uploaded, parsed, rejected). To read the code " +
    "afterwards use `search` (by meaning) or `code_lookup` (by structure), then `get` for a symbol's source. The first " +
    "index of a checkout on a machine set up with `agent:setup --index-repo` also opts it in: git hooks re-index it " +
    "after every commit, checkout, merge and rewrite, so later calls are only needed for uncommitted work.",

  schema: {
    session_id: sessionIdSchema,
    repo: z
      .string()
      .optional()
      .describe("Not used against a Cerebrium host: pass `path` or call from inside the checkout."),
    path: z
      .string()
      .optional()
      .describe("The checkout to index. Defaults to your working directory."),
    force: z
      .boolean()
      .optional()
      .describe("No effect: contents are addressed by hash, so nothing is re-parsed needlessly."),
  },
};
