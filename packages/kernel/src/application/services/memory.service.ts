import { inject, injectable } from "tsyringe";
import {
  SEARCH_REPO_TOKEN,
  STATS_REPO_TOKEN,
  type SearchRepo,
  type StatsRepo,
} from "@/domain/ports/storage";
import { estimateTokensOf } from "@/core/tokens";
import { RetrievalConfig } from "@/infrastructure/config";

const CHECKPOINT_LIMIT = 2;
const TASK_LIMIT = 10;
const SEMANTIC_LIMIT = 15;
const RECENT_LIMIT = 15;

@injectable()
export class MemoryService {
  constructor(
    @inject(SEARCH_REPO_TOKEN) private readonly searchRepo: SearchRepo,
    @inject(STATS_REPO_TOKEN) private readonly statsRepo: StatsRepo,
    private readonly retrieval: RetrievalConfig,
  ) {}

  public async getWorkingSet(project: string | undefined) {
    return {
      tasks: this.selectWithinBudget(await this.searchRepo.validTasks(project, TASK_LIMIT)),
      stats: await this.statsRepo.stats(),
      checkpoints: this.selectWithinBudget(
        await this.searchRepo.lastCheckpoints(project, CHECKPOINT_LIMIT),
      ),
      ...(project
        ? {
            semantic: this.selectWithinBudget(
              await this.searchRepo.validSemantic(project, SEMANTIC_LIMIT),
            ),
          }
        : {
            recent: this.selectWithinBudget(
              await this.searchRepo.recentValid(undefined, RECENT_LIMIT),
            ),
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
