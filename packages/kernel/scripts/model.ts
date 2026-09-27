// Minimal chat client for the local generation sidecar (Ollama, the same endpoint the
// `http` consolidation provider uses). Lives in `scripts/` because it serves the offline
// gold-set tooling only — the server's own generation path is the ConsolidationProvider
// port, and nothing here may be used from `src/`.

export interface ChatOptions {
  url?: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  numPredict?: number;
}

interface ChatResponse {
  message?: { content?: string };
}

export const DEFAULT_URL = "http://127.0.0.1:11434/api/chat";
export const DEFAULT_MODEL = "gemma4:12b-it-qat";

// ⚠️ `think: false` is load-bearing, not a tidy-up: with reasoning on, this model spends
// the whole `num_predict` budget on hidden thought and returns an EMPTY message.content
// (measured 2026-08-04: 21.7 s and nothing, versus 6.0 s and clean JSON with it off).
export async function chat(system: string, user: string, opts: ChatOptions = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 120_000);

  try {
    const res = await fetch(opts.url ?? DEFAULT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        stream: false,
        think: false,
        options: {
          temperature: opts.temperature ?? 0.7,
          num_predict: opts.numPredict ?? 400,
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`generation: HTTP ${String(res.status)}`);
    }

    const body = (await res.json()) as ChatResponse;

    if (typeof body.message?.content !== "string") {
      throw new Error("generation: response missing message.content");
    }

    return body.message.content;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`generation: timed out after ${String(opts.timeoutMs ?? 120_000)} ms`, {
        cause: err,
      });
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Small models fence their JSON, prefix it with prose, or both. Returns null rather than
// throwing so one unusable answer costs its own item and not the run.
export function parseJsonObject(content: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const body = fenced?.[1] ?? content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");

  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
