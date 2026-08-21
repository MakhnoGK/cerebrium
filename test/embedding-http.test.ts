import { describe, expect, it } from "vitest";
import { EmbeddingRole, VECTOR_DIM } from "@/domain/ports/embedding-provider";
import { HttpProvider, type FetchFn } from "@/embeddings/http";
import { createProvider } from "@/embeddings";

const MODEL = "multilingual-e5-small";

interface Sent {
  model: string;
  input: string[];
}

// A backend that answers with unit-length-agnostic vectors of the right width, recording
// what it was asked for.
function serve(sent: Sent[], vector: (i: number) => number[]): FetchFn {
  return (_url, init) => {
    const body = JSON.parse(init?.body as string) as { model: string; input: string[] };

    sent.push({ model: body.model, input: body.input });

    return Promise.resolve(
      new Response(JSON.stringify({ embeddings: body.input.map((_, i) => vector(i)) }), {
        status: 200,
      }),
    );
  };
}

function unitish(seed: number): number[] {
  return Array.from({ length: VECTOR_DIM }, (_, i) => (i === 0 ? 3 + seed : i === 1 ? 4 : 0));
}

describe("The http embedding provider", () => {
  it("should prefix by role, because e5 is asymmetric and the remote cannot know the side", async () => {
    // Given
    const sent: Sent[] = [];
    const provider = new HttpProvider({ model: MODEL, fetchFn: serve(sent, unitish) });

    // When
    await provider.embed(["a note"], EmbeddingRole.PASSAGE);
    await provider.embed(["a question"], EmbeddingRole.QUERY);

    // Then
    expect(sent.map((s) => s.input)).toEqual([["passage: a note"], ["query: a question"]]);
    expect(sent[0]?.model).toBe(MODEL);
  });

  it("should normalize what comes back, because cosine over unnormalized vectors is a silent error", async () => {
    // Given — 3-4-0... has length 5, so a normalized first component is 0.6.
    const provider = new HttpProvider({ model: MODEL, fetchFn: serve([], () => unitish(0)) });

    // When
    const [vector] = await provider.embed(["x"], EmbeddingRole.PASSAGE);

    // Then
    expect(vector?.[0]).toBeCloseTo(0.6, 10);
    expect(vector?.[1]).toBeCloseTo(0.8, 10);
    expect(norm(vector ?? [])).toBeCloseTo(1, 10);
  });

  it("should send the configured batch size per request and keep the order", async () => {
    // Given
    const sent: Sent[] = [];
    const provider = new HttpProvider({
      model: MODEL,
      batchSize: 2,
      fetchFn: serve(sent, unitish),
    });

    // When
    const out = await provider.embed(["a", "b", "c"], EmbeddingRole.PASSAGE);

    // Then
    expect(sent.map((s) => s.input)).toEqual([["passage: a", "passage: b"], ["passage: c"]]);
    expect(out).toHaveLength(3);
    expect(out[0]?.[0]).toBeCloseTo(0.6, 10);
    expect(out[2]?.[0]).toBeCloseTo(unitish(0)[0]! / norm(unitish(0)), 10);
  });

  it("should name the model when the vectors are the wrong width for this store", async () => {
    // Given
    const wide: FetchFn = () =>
      Promise.resolve(
        new Response(JSON.stringify({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }), {
          status: 200,
        }),
      );

    // When / Then
    await expect(
      new HttpProvider({ model: "nomic-embed-text", fetchFn: wide }).embed(
        ["x"],
        EmbeddingRole.PASSAGE,
      ),
    ).rejects.toThrow(/'nomic-embed-text' returned dim 768.*FLOAT\[384\]/s);
  });

  it("should refuse a body whose embedding count does not match the batch", async () => {
    // Given
    const short: FetchFn = () =>
      Promise.resolve(new Response(JSON.stringify({ embeddings: [unitish(0)] }), { status: 200 }));

    // When / Then
    await expect(
      new HttpProvider({ model: MODEL, fetchFn: short }).embed(["a", "b"], EmbeddingRole.PASSAGE),
    ).rejects.toThrow(/expected 2 embeddings, got 1/);
  });

  it("should carry the response body and the model knob in a non-2xx error", async () => {
    // Given
    const missing: FetchFn = () =>
      Promise.resolve(new Response('{"error":"model not found"}', { status: 404 }));

    // When / Then
    await expect(
      new HttpProvider({ model: MODEL, fetchFn: missing }).embed(["x"], EmbeddingRole.PASSAGE),
    ).rejects.toThrow(/HTTP 404.*model not found.*MEMORY_EMBED_MODEL/s);
  });

  it("should name the timeout rather than surface a bare abort", async () => {
    // Given
    const hangs: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });

    // When / Then
    await expect(
      new HttpProvider({ model: MODEL, timeoutMs: 5, fetchFn: hangs }).embed(
        ["x"],
        EmbeddingRole.PASSAGE,
      ),
    ).rejects.toThrow(/timed out after 5ms \(MEMORY_EMBED_TIMEOUT_MS\)/);
  });

  it("should embed a token on warm, so a wrong model fails at startup and not inside a write", async () => {
    // Given
    const sent: Sent[] = [];

    // When
    await new HttpProvider({ model: MODEL, fetchFn: serve(sent, unitish) }).warm();

    // Then
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input[0]).toMatch(/^passage: /);
  });

  it("should ask for nothing at all when there is nothing to embed", async () => {
    // Given
    const sent: Sent[] = [];

    // When
    const out = await new HttpProvider({ model: MODEL, fetchFn: serve(sent, unitish) }).embed(
      [],
      EmbeddingRole.PASSAGE,
    );

    // Then
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("Choosing the provider", () => {
  it("should build the http provider by name and leave local the default", () => {
    // Then
    expect(createProvider("http", MODEL, undefined, { url: "http://h/api/embed" }).name).toBe(
      MODEL,
    );
    expect(createProvider("local-null").name).toContain("null");
  });
});

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((t, x) => t + x * x, 0));
}

describe("The model worker's provider", () => {
  it("should be built from the settings it was handed, not from the environment it inherited", () => {
    // Given — what the daemon resolves and passes as workerData. A worker that read the
    // environment instead saw only the env tier, so a `config.json` selecting `http` left
    // it loading a local model.
    const settings = {
      provider: "http",
      model: MODEL,
      cacheDir: "/unused",
      url: "http://remote:11434/api/embed",
      timeoutMs: 1_000,
      batchSize: 8,
    };

    // When
    const provider = createProvider(settings.provider, settings.model, settings.cacheDir, {
      url: settings.url,
      timeoutMs: settings.timeoutMs,
      batchSize: settings.batchSize,
    });

    // Then
    expect(provider.name).toBe(MODEL);
    expect(provider.dim).toBe(VECTOR_DIM);
  });
});
