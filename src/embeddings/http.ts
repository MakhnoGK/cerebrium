import {
  EmbeddingRole,
  VECTOR_DIM,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";

export type FetchFn = typeof fetch;

// Embeddings from a model served over HTTP instead of loaded into this process, which is
// what takes the 4.6-5.7s load/unload cycle off the daemon's own thread. Targets Ollama's
// `/api/embed` ({model, input: string[]} -> {embeddings: number[][]}); a single-vector
// `{embedding}` body is accepted too, which is what the older `/api/embeddings` returns.
//
// The model on the other end MUST be the one the store was embedded with. Dimension is
// checked on every response and a mismatch throws, but 384 dimensions from a *different*
// model is not an error any check here can see — it silently re-bases the vector space
// against every stored vector. `scripts/embed-agreement.mts` is how that is ruled out
// before a provider is switched.
const DEFAULTS = {
  url: "http://127.0.0.1:11434/api/embed",
  timeoutMs: 30_000,
  batchSize: 64,
};

interface EmbedResponse {
  embeddings?: unknown;
  embedding?: unknown;
}

export class HttpProvider implements EmbeddingProvider {
  readonly name: string;
  readonly version = "1";
  readonly dim = VECTOR_DIM;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly fetchFn: FetchFn;

  constructor(opts?: {
    model?: string;
    url?: string;
    timeoutMs?: number;
    batchSize?: number;
    fetchFn?: FetchFn;
  }) {
    this.model = opts?.model ?? "";
    this.name = this.model;
    this.url = opts?.url ?? DEFAULTS.url;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
    this.batchSize = opts?.batchSize ?? DEFAULTS.batchSize;
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  async embed(texts: string[], role: EmbeddingRole): Promise<number[][]> {
    if (texts.length === 0) return [];

    // E5 is asymmetric and the prefixes are mandatory, exactly as in the local provider:
    // the remote sees text that is already prefixed, because the port makes prefixing the
    // provider's job and a server cannot know which side of the pair it is embedding.
    const prefix = role === EmbeddingRole.QUERY ? "query: " : "passage: ";
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => prefix + t);

      out.push(...(await this.post(batch)));
    }

    return out;
  }

  // A one-token embed, so a wrong model, a wrong endpoint or a wrong dimension is a
  // startup failure in the daemon rather than a failure inside the first write that needs
  // a vector.
  async warm(): Promise<void> {
    await this.embed(["warm"], EmbeddingRole.PASSAGE);
  }

  private async post(input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");

        throw new Error(
          `http embedding provider: HTTP ${String(res.status)} from ${this.url}` +
            `${detail ? `: ${detail.slice(0, 300)}` : ""} (model '${this.model}', MEMORY_EMBED_MODEL)`,
        );
      }

      return this.vectors((await res.json()) as EmbedResponse, input.length);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `http embedding provider: timed out after ${String(this.timeoutMs)}ms (MEMORY_EMBED_TIMEOUT_MS)`,
          { cause: err },
        );
      }

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private vectors(body: EmbedResponse, expected: number): number[][] {
    const raw = Array.isArray(body.embeddings)
      ? body.embeddings
      : Array.isArray(body.embedding)
        ? [body.embedding]
        : null;

    if (raw?.length !== expected) {
      throw new Error(
        `http embedding provider: expected ${String(expected)} embeddings, got ` +
          (raw === null ? "a body with no embeddings" : String(raw.length)),
      );
    }

    return raw.map((vector) => {
      if (!Array.isArray(vector) || vector.length !== this.dim) {
        throw new Error(
          `http embedding provider: model '${this.model}' returned ${
            Array.isArray(vector) ? `dim ${String(vector.length)}` : "a non-vector"
          }, but this store is FLOAT[${String(this.dim)}] — point MEMORY_EMBED_MODEL at the model the store was embedded with`,
        );
      }

      return normalize(vector as number[]);
    });
  }
}

// The local path asks transformers.js for `normalize: true`; `/api/embed` makes no such
// promise, and cosine over unnormalized vectors is a silent ranking error rather than a
// visible failure.
function normalize(vector: number[]): number[] {
  let sum = 0;

  for (const x of vector) sum += x * x;

  const norm = Math.sqrt(sum);

  return norm === 0 ? vector : vector.map((x) => x / norm);
}
