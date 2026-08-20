import { readFileSync } from "node:fs";
import type { ConfigSource, ConfigValue } from "@/domain/ports/config";

export type ConfigFileState = "loaded" | "absent" | "unreadable";

export interface ConfigFileReport {
  path: string;
  state: ConfigFileState;
  // Set only when `state` is "unreadable": what went wrong, in one line.
  problem?: string;
  // Scalar leaves the file contributes, so an empty or all-comment file is visible as one.
  keys: number;
}

// `$CEREBRIUM_HOME/config.json`, the file-as-truth tier. Keyed by dotted CONFIG PATH
// (`consolidation.posture.merge`), not by env-var name, so what a human edits matches
// what `status` prints.
//
// A missing file is normal and silent. A corrupt one degrades to env + defaults and is
// reported rather than thrown: this process is the daily working memory, and a stray
// comma must not leave the agent with no store at all. A non-scalar leaf is handed back
// as JSON so the existing "unparseable -> default, and record it" path reports it as an
// ignored value instead of needing a second mechanism.
export class FileConfigSource implements ConfigSource {
  private readonly tree: Record<string, unknown>;
  private readonly state: ConfigFileState;
  private readonly problem?: string;

  constructor(
    private readonly path: string,
    load: (path: string) => string = (p) => readFileSync(p, "utf8"),
  ) {
    let text: string;

    try {
      text = load(path);
    } catch {
      this.tree = {};
      this.state = "absent";
      return;
    }

    try {
      const parsed: unknown = JSON.parse(text);

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object at the top level");
      }

      this.tree = parsed as Record<string, unknown>;
      this.state = "loaded";
    } catch (err) {
      this.tree = {};
      this.state = "unreadable";
      this.problem = (err as Error).message;
    }
  }

  read(path: string): ConfigValue | undefined {
    const leaf = walk(this.tree, path.split("."));

    if (leaf === undefined || leaf === null) {
      return undefined;
    }

    return { raw: scalarText(leaf), origin: "file" };
  }

  report(): ConfigFileReport {
    return {
      path: this.path,
      state: this.state,
      ...(this.problem === undefined ? {} : { problem: this.problem }),
      keys: countScalars(this.tree),
    };
  }
}

// JSON.parse only ever hands back objects, arrays, strings, numbers, booleans and null,
// so the default branch is exactly the non-scalar case the caller reports as ignored.
function scalarText(leaf: NonNullable<unknown>): string {
  switch (typeof leaf) {
    case "string":
      return leaf;
    case "number":
    case "boolean":
      return String(leaf);
    default:
      return JSON.stringify(leaf);
  }
}

function walk(tree: Record<string, unknown>, segments: string[]): unknown {
  return segments.reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return undefined;
    }

    return (node as Record<string, unknown>)[segment];
  }, tree);
}

function countScalars(node: unknown): number {
  if (node === null || node === undefined) return 0;
  if (typeof node !== "object") return 1;
  if (Array.isArray(node)) return 1;

  return Object.values(node).reduce<number>((total, child) => total + countScalars(child), 0);
}
