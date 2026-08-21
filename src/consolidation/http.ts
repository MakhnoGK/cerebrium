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
  ANNOTATE_SCHEMA,
  ANNOTATE_SYSTEM_PROMPT,
  annotatePrompt,
  parseAnnotate,
  parseReconcile,
  parseResult,
  RECONCILE_SCHEMA,
  RECONCILE_SYSTEM_PROMPT,
  reconcilePrompt,
  RESULT_SCHEMA,
  SYSTEM_PROMPT,
  taskPrompt,
} from "@/consolidation/provider";

export type FetchFn = typeof fetch;

interface ChatResponse {
  message?: { content?: string };
}

// HTTP generation provider, defaulting to a local Ollama `/api/chat` with structured
// outputs (`format` = the result JSON schema) so the reply parses cleanly, and with the
// model's reasoning mode off (see `post`). Any transport failure, non-2xx, timeout, or
// malformed body throws — the caller (daemon) then degrades to `suggest`, exactly like the
// reranker's graceful fallback. `fetchFn` is injectable so the contract is testable offline
// without a live model.
// Fallbacks for a directly-constructed adapter (tests). Production values come from
// ConsolidationConfig via createConsolidator.
const DEFAULTS = {
  url: "http://127.0.0.1:11434/api/chat",
  model: "gemma4:12b-it-qat",
  timeoutMs: 500_000,
  reconcileTimeoutMs: 25_000,
};

// A budget and the knob that raises it, so a timeout says which one it was.
interface Deadline {
  ms: number;
  env: string;
}

export class HttpConsolidator implements ConsolidationProvider {
  readonly name = "http";
  readonly version = "1";
  readonly enabled = true;
  private readonly url: string;
  private readonly model: string;
  private readonly generation: Deadline;
  private readonly interactive: Deadline;
  private readonly fetchFn: FetchFn;
  // Flipped for the process once a backend rejects the field; see `chat`.
  private thinkSupported = true;

  constructor(opts?: {
    url?: string;
    model?: string;
    timeoutMs?: number;
    reconcileTimeoutMs?: number;
    fetchFn?: FetchFn;
  }) {
    this.url = opts?.url ?? DEFAULTS.url;
    this.model = opts?.model ?? DEFAULTS.model;
    this.generation = {
      ms: opts?.timeoutMs ?? DEFAULTS.timeoutMs,
      env: "MEMORY_CONSOLIDATE_TIMEOUT_MS",
    };
    this.interactive = {
      ms: opts?.reconcileTimeoutMs ?? DEFAULTS.reconcileTimeoutMs,
      env: "MEMORY_CONSOLIDATE_RECONCILE_TIMEOUT_MS",
    };
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  async generate(task: ConsolidationTask): Promise<ConsolidationResult> {
    return parseResult(
      await this.chat(SYSTEM_PROMPT, taskPrompt(task), RESULT_SCHEMA, this.generation),
    );
  }

  async reconcile(task: ReconcileTask): Promise<ReconcileResult> {
    return parseReconcile(
      await this.chat(
        RECONCILE_SYSTEM_PROMPT,
        reconcilePrompt(task),
        RECONCILE_SCHEMA,
        this.interactive,
      ),
    );
  }

  async annotate(task: AnnotateTask): Promise<AnnotateResult> {
    return parseAnnotate(
      await this.chat(
        ANNOTATE_SYSTEM_PROMPT,
        annotatePrompt(task),
        ANNOTATE_SCHEMA,
        this.generation,
      ),
    );
  }

  // One structured-output chat round-trip. Returns the raw message.content string for a
  // task-specific parser. Any transport failure, non-2xx, timeout, or malformed body
  // throws — the caller (daemon or write tool) then degrades gracefully. Every throw names
  // what went wrong, because the caller's only other signal is the absence of a proposal:
  // a timeout, a dead endpoint and a model with nothing to say look identical otherwise.
  private async chat(
    system: string,
    user: string,
    format: object,
    deadline: Deadline,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, deadline.ms);
    try {
      let res = await this.post(system, user, format, controller.signal);

      // A backend that has no reasoning mode rejects the field outright. Retrying once
      // without it, and remembering that for the process, keeps this adapter working
      // against any Ollama-compatible model instead of failing every call on one word.
      if (!res.ok && this.thinkSupported && (await rejectsThinking(res))) {
        this.thinkSupported = false;
        res = await this.post(system, user, format, controller.signal);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");

        throw new Error(
          `consolidation http provider: HTTP ${String(res.status)}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        );
      }
      const body = (await res.json()) as ChatResponse;
      const content = body.message?.content;
      if (typeof content !== "string") {
        throw new Error("consolidation http provider: response missing message.content");
      }
      return content;
    } catch (err) {
      // The abort surfaces as a generic DOMException, which reads like a network blip.
      // Naming the timeout is what tells an operator to raise it rather than hunt a bug.
      if (controller.signal.aborted) {
        throw new Error(
          `consolidation http provider: timed out after ${String(deadline.ms)}ms (${deadline.env})`,
          { cause: err },
        );
      }

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ⚠️ `think: false` is a latency fix, not a preference. A reasoning model spends its
  // decode budget on hidden thought that this adapter never reads: measured 2026-08-04 on
  // a real 6k-char merge cluster, the same call takes 61.8 s with reasoning on and 24.9 s
  // with it off, for the same 1.1 kB of parsed JSON. That 2.5x is what pushed calls past
  // the old 60 s timeout and made proposals vanish mid-decode.
  private post(
    system: string,
    user: string,
    format: object,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format,
        ...(this.thinkSupported ? { think: false } : {}),
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal,
    });
  }
}

// Ollama answers a `think` it cannot honour with a 400 naming the field. Read from a clone
// so the caller can still consume the original body for its own error message.
async function rejectsThinking(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;

  const detail = await res
    .clone()
    .text()
    .catch(() => "");

  return /think/i.test(detail);
}
