import { inject } from "tsyringe";
import {
  CONSOLIDATION_REPO_TOKEN,
  SESSIONS_REPO_TOKEN,
  type ConsolidationRepo,
  type SessionsRepo,
} from "@/domain/ports/storage";
import {
  RECENT_ACTIVITY,
  useCase,
  type RecentActivity,
  type RecentActivityArgs,
  type RecentActivityResult,
} from "@/application/use-cases/contracts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const RUNS = 30;

@useCase(RECENT_ACTIVITY)
export class LocalRecentActivity implements RecentActivity {
  constructor(
    @inject(SESSIONS_REPO_TOKEN) private readonly sessions: SessionsRepo,
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
  ) {}

  async invoke(args: RecentActivityArgs): Promise<RecentActivityResult> {
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    return {
      events: await this.sessions.recentEvents(limit, args.before ?? null),
      runs: args.before === undefined ? await this.consolidation.recentRuns(RUNS) : [],
    };
  }
}
