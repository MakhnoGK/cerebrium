import { inject, injectable } from "tsyringe";
import {
  EDGES_REPO_TOKEN,
  NODES_REPO_TOKEN,
  type EdgesRepo,
  type NodesRepo,
} from "@/domain/ports/storage";

@injectable()
export class NodeReferenceService {
  constructor(
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    @inject(EDGES_REPO_TOKEN) private readonly edges: EdgesRepo,
  ) {}

  async requireLive(id: string, label = "node"): Promise<void> {
    const state = await this.nodes.referenceState(id);

    if (state === "live") return;
    if (state === "missing") throw new Error(`${label} ${id} does not exist.`);

    const successors = await this.terminalLiveSuccessors(id);

    if (successors.length === 1) {
      throw new Error(`${label} ${id} is invalidated. Use live successor ${successors[0]}.`);
    }

    if (successors.length > 1) {
      throw new Error(
        `${label} ${id} is invalidated and has multiple live successors: ${successors.join(", ")}.`,
      );
    }

    throw new Error(`${label} ${id} is invalidated and has no live successor.`);
  }

  // Where a retired node's identity went: the live nodes reachable by following
  // `supersedes` forward, however many hops it takes. More than one means the question
  // has no single answer and the caller has to say so rather than pick.
  async terminalLiveSuccessors(id: string): Promise<string[]> {
    const live = new Set<string>();
    const visited = new Set<string>();
    const pending = [id];

    while (pending.length) {
      const current = pending.pop()!;

      if (visited.has(current)) continue;
      visited.add(current);

      for (const successor of await this.edges.liveSuccessorsOf(current)) {
        const state = await this.nodes.referenceState(successor);

        if (state === "live") live.add(successor);
        if (state === "invalidated" && !visited.has(successor)) pending.push(successor);
      }
    }

    return [...live].sort();
  }
}
