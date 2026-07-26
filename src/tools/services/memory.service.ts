import { injectable } from "tsyringe";
import { MirrorRepo, SearchRepo, StatsRepo } from "@/db/repositories";
import { estimateTokensOf } from "@/core/tokens";
import { Context } from "@/core/context";

const CHECKPOINT_LIMIT = 2;
const TASK_LIMIT = 10;
const SEMANTIC_LIMIT = 15;
const RECENT_LIMIT = 15;

@injectable()
export class MemoryService {
  constructor(
    private readonly searchRepo: SearchRepo,
    private readonly mirrorRepo: MirrorRepo,
    private readonly statsRepo: StatsRepo,
    private readonly ctx: Context,
  ) {}

  public getWorkingSet(project: string | undefined) {
    // Freshness hook: nudge the agent to re-sync external mirror sources that are past
    // their freshness window. Only registered, enabled, stale sources; omitted entirely
    // when there are none (a deployment with no sources sees no change).
    const stale = this.mirrorRepo
      .sourceStatus(new Date().toISOString())
      .filter((s) => s.stale)
      .map((s) => ({ id: s.id, label: s.label, hours_stale: s.hours_stale }));

    return {
      tasks: this.selectWithinBudget(this.searchRepo.validTasks(project, TASK_LIMIT)),
      stats: this.statsRepo.stats(),
      checkpoints: this.selectWithinBudget(
        this.searchRepo.lastCheckpoints(project, CHECKPOINT_LIMIT),
      ),
      ...(stale.length ? { stale_sources: this.selectWithinBudget(stale) } : {}),
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
    const budget = this.ctx.workingSetBudget;
    let spent = 0;

    return items.filter((item) => {
      const estimatedTokens = estimateTokensOf(item);

      if (spent + estimatedTokens > budget) {
        return false;
      }

      spent += estimatedTokens;

      return true;
    });
  }
}
