import type { DependencyContainer } from "tsyringe";
import {
  CODE_COMMIT,
  CODE_MANIFEST,
  CODE_UPLOAD,
  type IndexCode,
  type IndexCodeArgs,
  type IndexCodeResult,
} from "@cerebrium/kernel/application/use-cases";
import { cerebriumHome } from "@cerebrium/kernel/runtime/paths";
import { indexCheckout, type CodeCalls } from "@plugin/src/code/client-indexer";
import { optInCheckout } from "@plugin/src/code/index-opt-in";

export function codeCalls(container: DependencyContainer): CodeCalls {
  return {
    manifest: (args) => container.resolve(CODE_MANIFEST).invoke(args),
    upload: (args) => container.resolve(CODE_UPLOAD).invoke(args),
    commit: (args) => container.resolve(CODE_COMMIT).invoke(args),
  };
}

// `code_index` on a machine whose memory lives on a host: the host has no checkout to read,
// so this side walks the one it runs in and uploads what the host lacks.
export class ClientIndexCode implements IndexCode {
  constructor(
    private readonly container: DependencyContainer,
    private readonly cwd: () => string = () => process.cwd(),
    private readonly optIn: (root: string) => string | null = (root) =>
      optInCheckout(cerebriumHome(), root, process.execPath),
  ) {}

  async invoke(args: IndexCodeArgs): Promise<IndexCodeResult> {
    if (args.repo !== undefined && args.path === undefined) {
      throw new Error(
        "on a Cerebrium host code_index indexes a checkout, not a configured name: pass `path` " +
          "or call it from inside the checkout.",
      );
    }

    const started = Date.now();
    const done = await indexCheckout(
      args.path ?? this.cwd(),
      args.session_id,
      codeCalls(this.container),
    );
    const r = done.result;
    const notes = [
      `${done.checkout.display_name}@${r.branch}: ${String(r.files)} files, ${String(done.uploaded)} uploaded, ` +
        `${String(r.units_parsed)} parsed on the host.`,
    ];

    if (r.parse_failures) notes.push(`${String(r.parse_failures)} file(s) failed to parse.`);

    if (done.rejected.length) {
      notes.push(
        `not indexed: ${done.rejected
          .slice(0, 5)
          .map((x) => `${x.path} (${x.reason})`)
          .join(", ")}${done.rejected.length > 5 ? ", …" : ""}`,
      );
    }

    if (r.branches_retired.length)
      notes.push(`retired branches: ${r.branches_retired.join(", ")}.`);

    if (args.force) notes.push("`force` has no effect here: contents are addressed by hash.");

    try {
      const opted = this.optIn(done.checkout.root);

      if (opted) notes.push(opted);
    } catch (err) {
      notes.push(`indexed, but not opted in for re-indexing: ${(err as Error).message}`);
    }

    return {
      results: [
        {
          repo: done.checkout.display_name,
          files_scanned: done.listed,
          files_indexed: r.files_changed,
          files_skipped: done.skipped,
          symbols_added: r.symbols_added,
          symbols_updated: 0,
          symbols_invalidated: 0,
          edges_written: 0,
          duration_ms: Date.now() - started,
          parked_embeddings: 0,
          branch: r.branch,
          commit: r.commit,
          dirty: done.checkout.dirty,
        },
      ],
      notes,
    };
  }
}
