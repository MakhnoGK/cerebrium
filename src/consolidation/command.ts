import { spawn } from "node:child_process";
import {
  type AnnotateResult,
  type AnnotateTask,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
  type ReconcileResult,
  type ReconcileTask,
} from "@/domain/ports/consolidation-provider";
import {
  ANNOTATE_SYSTEM_PROMPT,
  annotatePrompt,
  parseAnnotate,
  parseReconcile,
  parseResult,
  RECONCILE_SYSTEM_PROMPT,
  reconcilePrompt,
  SYSTEM_PROMPT,
  taskPrompt,
} from "@/consolidation/provider";
import { resolveRoles, type ResolvedRoles } from "@/consolidation/roles";
import { GenerationRole } from "@/core/vocab";

// Runs a user command, feeding `input` on stdin and resolving with its stdout. Rejects
// on non-zero exit, timeout, or spawn error.
export type CommandRunner = (input: string) => Promise<string>;

// The universal "bring your own model/agent/api" adapter: the daemon pipes a task as JSON
// on stdin to a user-configured command and reads a ConsolidationResult (or the raw
// {title,summary,body} JSON) on stdout. Any failure throws -> caller degrades to suggest.
// `runner` is injectable so the stdin/stdout contract is testable without spawning.
export class CommandConsolidator implements ConsolidationProvider {
  readonly name = "command";
  readonly version = "1";
  readonly enabled = true;
  // One runner per role: each carries that role's deadline, and the role's model travels in
  // the payload so a user process can route on it too.
  private readonly runners: Record<GenerationRole, CommandRunner>;
  private readonly roles: ResolvedRoles;

  constructor(opts?: {
    roles?: ResolvedRoles;
    cmd?: string;
    timeoutMs?: number;
    reconcileTimeoutMs?: number;
    runner?: CommandRunner;
  }) {
    this.roles =
      opts?.roles ??
      resolveRoles({
        url: "",
        model: "",
        timeoutMs: opts?.timeoutMs ?? 500_000,
        reconcileTimeoutMs: opts?.reconcileTimeoutMs ?? 25_000,
      });
    this.runners = {
      [GenerationRole.GENERATE]:
        opts?.runner ?? defaultRunner(opts?.cmd, this.roles[GenerationRole.GENERATE].timeoutMs),
      [GenerationRole.RECONCILE]:
        opts?.runner ?? defaultRunner(opts?.cmd, this.roles[GenerationRole.RECONCILE].timeoutMs),
      [GenerationRole.ANNOTATE]:
        opts?.runner ?? defaultRunner(opts?.cmd, this.roles[GenerationRole.ANNOTATE].timeoutMs),
    };
  }

  async generate(task: ConsolidationTask): Promise<ConsolidationResult> {
    const input = JSON.stringify({
      task: "consolidate",
      system: SYSTEM_PROMPT,
      kind: task.kind,
      model: this.roles[GenerationRole.GENERATE].model,
      project: task.project,
      prompt: taskPrompt(task),
      inputs: task.inputs,
    });
    return parseResult(await this.runners[GenerationRole.GENERATE](input));
  }

  async reconcile(task: ReconcileTask): Promise<ReconcileResult> {
    const input = JSON.stringify({
      task: "reconcile",
      system: RECONCILE_SYSTEM_PROMPT,
      model: this.roles[GenerationRole.RECONCILE].model,
      project: task.project,
      prompt: reconcilePrompt(task),
      draft: task.draft,
      candidates: task.candidates,
    });
    return parseReconcile(await this.runners[GenerationRole.RECONCILE](input));
  }

  async annotate(task: AnnotateTask): Promise<AnnotateResult> {
    const input = JSON.stringify({
      task: "annotate",
      system: ANNOTATE_SYSTEM_PROMPT,
      model: this.roles[GenerationRole.ANNOTATE].model,
      project: task.project,
      prompt: annotatePrompt(task),
      title: task.title,
      content: task.content,
    });
    return parseAnnotate(await this.runners[GenerationRole.ANNOTATE](input));
  }
}

function defaultRunner(cmd: string | undefined, timeoutMs: number): CommandRunner {
  return (input: string) =>
    new Promise<string>((resolve, reject) => {
      if (!cmd) {
        reject(new Error("consolidation command provider: MEMORY_CONSOLIDATE_CMD is not set"));
        return;
      }
      const child = spawn(cmd, { shell: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("consolidation command provider: timed out"));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else
          reject(
            new Error(`consolidation command provider: exit ${String(code)}: ${err.slice(0, 200)}`),
          );
      });
      child.stdin.end(input);
    });
}
