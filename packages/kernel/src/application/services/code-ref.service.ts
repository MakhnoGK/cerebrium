import { inject, injectable } from "tsyringe";
import type { CodeContext } from "@cerebrium/contracts/code";
import {
  BRANCH_CODE_REPO_TOKEN,
  NODES_REPO_TOKEN,
  STORE_TOKEN,
  type BranchCodeRepo,
  type CodeRefRow,
  type NodesRepo,
  type Store,
} from "@/domain/ports/storage";

export type CodeRefTarget = Omit<CodeRefRow, "src" | "type">;

// A note's link into code. On the per-branch index a symbol id names one parse of one file,
// so the link is kept by what it points at — repo, path, qualified name — and resolved
// against whichever branch a later read is on.
@injectable()
export class CodeRefService {
  constructor(
    @inject(STORE_TOKEN) private readonly store: Store,
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    @inject(BRANCH_CODE_REPO_TOKEN) private readonly code: BranchCodeRepo,
  ) {}

  // The ref a link to `id` would record, or null when `id` is not a code symbol here.
  async target(id: string, ctx?: CodeContext): Promise<CodeRefTarget | null> {
    if (!this.store.capabilities.branchCode) return null;

    if ((await this.nodes.referenceState(id)) !== "missing") return null;

    const detail = await this.code.symbolDetail(id);

    if (!detail) return null;

    const holding = await this.code.branchesHolding(detail.unit_id);
    const repos = [...new Map(holding.map((h) => [h.remote_key, h])).values()];
    const home =
      repos.find((r) => r.remote_key === ctx?.remote_key) ??
      (repos.length === 1 ? repos[0] : undefined);

    if (!home) {
      throw new Error(
        repos.length
          ? `symbol ${id} is live in several repos (${repos.map((r) => r.remote_key).join(", ")}); ` +
              "link it from a checkout of the one you mean."
          : `symbol ${id} is not live on any indexed branch; look it up again and link the current id.`,
      );
    }

    return {
      repo: home.display_name,
      remote_key: home.remote_key,
      path: detail.path,
      qualified: detail.qualified,
      symbol_kind: detail.kind,
    };
  }

  async record(src: string, type: string, target: CodeRefTarget, ts: string): Promise<void> {
    await this.code.insertRef({ src, type, ...target }, ts);
  }
}
