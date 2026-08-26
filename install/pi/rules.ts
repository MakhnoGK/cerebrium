import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every other host keeps the always-on block inside a file the user owns, between markers,
// and setup rewrites it when the doctrine changes. pi lets an extension chain the system
// prompt per turn, so the block is read from the working tree at session start instead —
// no managed block, no file of the user's to edit, nothing to drift.

const START = "<!-- cerebrium:start";
const END = "<!-- cerebrium:end -->";

const PI_NOTE = `## In pi

Cerebrium is bridged into pi by an extension, not by an MCP client, so:

- Every memory tool is registered with a \`cerebrium_\` prefix: \`cerebrium_search\`,
  \`cerebrium_write\`, \`cerebrium_get\`, \`cerebrium_checkpoint\`, and so on. The tool names
  used in the rules above and in the \`cerebrium\` skill are the unprefixed ones.
- \`session_start\` has already been called for you, and its working set was posted into this
  conversation. Quote the \`session_id\` from it. If a call omits \`session_id\`, the bridge
  fills in that same id — it never invents one.
- \`/cerebrium\` reports the bridge status, restarts it, or re-indexes the current repository.`;

export function stripMarkers(text: string): string {
  const start = text.indexOf(START);
  const body = start === -1 ? text : text.slice(text.indexOf("-->", start) + 3);
  const end = body.indexOf(END);
  return (end === -1 ? body : body.slice(0, end)).trim();
}

export function alwaysOnRules(repoRoot: string): string {
  return stripMarkers(readFileSync(join(repoRoot, "install", "always-on.md"), "utf8"));
}

export function systemPromptBlock(repoRoot: string): string {
  return `${alwaysOnRules(repoRoot)}\n\n${PI_NOTE}`;
}
