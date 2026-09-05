import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { SessionService } from "@/application/services/session.service";
import type { AgentRunReport } from "@/application/use-cases/contracts/runner";
import { JobsRepo, NodesRepo, type JobRow } from "@/db/repositories";
import type { Writer } from "@/runtime/client-identity";
import { newId } from "@/core/ids";
import { AGENT_JOB_PREFIX, MemoryKind } from "@/core/vocab";

// The runner host's side of the queue, served over the daemon socket rather than the call
// surface: claiming and reporting a job are operational, not memory calls, and putting them
// on the surface would hand every principal the queue's internals.
//
// The runner writes nothing itself. It reports an outcome and the daemon records it, so a
// runner that is buggy or compromised can move job rows and spend budget, but cannot author
// memory. What the *spawned agent* writes is a separate matter, governed by the
// `cerebrium-runner` principal profile.

// Recorded by the daemon on the runner's behalf, so the writer is the system.
const RUN_WRITER: Writer = { client: "cerebrium-jobs", version: null };

const LEASE_MS = 900_000;

function money(usd: number | null): string {
  return usd === null ? "unknown cost" : `$${usd.toFixed(4)}`;
}

function tokensOf(report: AgentRunReport): number | null {
  const u = report.usage;

  return u === null
    ? null
    : u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
}

@injectable()
export class AgentRunService {
  constructor(
    private readonly jobs: JobsRepo,
    private readonly nodes: NodesRepo,
    private readonly sessions: SessionService,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  // Only `agent.*`. The daemon's own JobWorker owns everything else, and a runner that
  // could claim `code.index` would be running kernel work in the wrong process.
  claim(kinds: string[], owner: string): JobRow | null {
    const agentKinds = kinds.filter((kind) => kind.startsWith(AGENT_JOB_PREFIX));

    if (!agentKinds.length) return null;

    return this.jobs.claim({
      kinds: agentKinds,
      owner,
      now: this.clock.now(),
      leaseMs: LEASE_MS,
    });
  }

  // The mirror of `submit_job`, which accepts only `code.*`: this accepts only `agent.*`.
  // The kernel deliberately does not know which agent tasks exist — that registry lives in
  // the runner — so an unregistered kind is rejected there, when it is claimed, not here.
  //
  // `everyMs` makes the enqueue conditional on the kind being due, and answers null when it
  // is not. The cadence still belongs to the caller's registry; only the race does not.
  enqueue(kind: string, payload: Record<string, unknown>, everyMs?: number): JobRow | null {
    if (!kind.startsWith(AGENT_JOB_PREFIX)) {
      throw new Error(`${kind} is not an agent job; kernel work goes through submit_job`);
    }

    const now = this.clock.now();
    const job = { id: newId(), kind, payload, scheduled_for: now, now };

    return everyMs === undefined
      ? this.jobs.submit(job)
      : this.jobs.submitIfDue({ ...job, everyMs });
  }

  renew(id: string, owner: string): boolean {
    return this.jobs.renew(id, owner, this.clock.now(), LEASE_MS);
  }

  // Closes the job and records the run. The record is written even when the run failed —
  // a timeout that still cost money is exactly the thing that has to be findable later.
  async finish(id: string, owner: string, report: AgentRunReport): Promise<boolean> {
    const job = this.jobs.byId(id);

    if (job?.lease_owner !== owner) return false;

    const now = this.clock.now();
    const ok = report.exit === "completed";

    const closed = ok
      ? this.jobs.succeed(id, owner, report, now)
      : this.jobs.fail(id, owner, report.error ?? report.exit, now);

    if (!closed) return false;

    await this.record(job, report, now);

    return true;
  }

  private async record(job: JobRow, report: AgentRunReport, now: string): Promise<void> {
    const sessionId = newId();

    this.sessions.startSession(sessionId, null, now, RUN_WRITER);

    const tokens = tokensOf(report);
    const seconds = (report.duration_ms / 1000).toFixed(1);

    await this.nodes.createNode({
      memory_kind: MemoryKind.EPISODIC,
      type: "event_note",
      title: `${job.kind} run ${report.exit} in ${seconds}s (${money(report.cost_usd)})`,
      content: [
        `An unattended agent run of \`${job.kind}\`, job \`${job.id}\`.`,
        "",
        `- **outcome**: ${report.exit}${report.error === null ? "" : ` — ${report.error}`}`,
        `- **spent**: ${money(report.cost_usd)} equivalent${tokens === null ? "" : `, ${tokens.toLocaleString("en-US")} tokens`}`,
        `- **model**: ${report.model ?? "unknown"}`,
        `- **turns**: ${report.turns ?? "unknown"}, **wall clock**: ${seconds}s`,
        ...(report.permission_denials > 0
          ? [`- **refused tool calls**: ${String(report.permission_denials)}`]
          : []),
        "",
        "What it reported back:",
        "",
        "```",
        (report.result ?? "(nothing)").slice(0, 2000),
        "```",
        "",
        "The cost is drawn from the owner's subscription, not billed per token — it is the",
        "CLI's own equivalent figure. Recorded on every run so the week's total is answerable.",
      ].join("\n"),
      project: "cerebrium",
      session_id: sessionId,
      // No edges: a job id is a queue row, not a node, and pointing an edge at one would
      // dangle. A task that touches real nodes draws its own edges as it goes.
      ts: now,
    });
  }
}
