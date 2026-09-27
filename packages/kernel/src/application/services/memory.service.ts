import { injectable } from "tsyringe";
import { SearchRepo, StatsRepo } from "@/db/repositories";
import { estimateTokensOf } from "@/core/tokens";
import { RetrievalConfig } from "@/infrastructure/config";

const CHECKPOINT_LIMIT = 2;
const TASK_LIMIT = 10;
const SEMANTIC_LIMIT = 15;
const RECENT_LIMIT = 15;

@injectable()
export class MemoryService {
  constructor(
    private readonly searchRepo: SearchRepo,
    private readonly statsRepo: StatsRepo,
    private readonly retrieval: RetrievalConfig,
  ) {}

  public getWorkingSet(project: string | undefined) {
    return {
      tasks: this.selectWithinBudget(this.searchRepo.validTasks(project, TASK_LIMIT)),
      stats: this.statsRepo.stats(),
      checkpoints: this.selectWithinBudget(
        this.searchRepo.lastCheckpoints(project, CHECKPOINT_LIMIT),
      ),
      ...(project
        ? {
            semantic: this.selectWithinBudget(
              this.searchRepo.validSemantic(project, SEMANTIC_LIMIT),
            ),
          }
        : {
            recent: this.selectWithinBudget(this.searchRepo.recentValid(undefined, RECENT_LIMIT)),
          }),
    };
  }

  private selectWithinBudget<T>(items: T[]) {
    const budget = this.retrieval.workingSetTokens;

    return items.reduce<{ spent: number; items: T[] }>(
      (acc, item) => {
        const estimated = estimateTokensOf(item);

        if (acc.spent + estimated > budget) {
          return acc;
        }

        return { spent: acc.spent + estimated, items: [...acc.items, item] };
      },
      { spent: 0, items: [] },
    ).items;
  }
}
