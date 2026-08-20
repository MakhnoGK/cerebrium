import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { ModelWarmupService } from "@/application/services";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

beforeEach(() => {
  env = setup();
});

// A provider whose load cost is whatever the test says it is. `warm` is optional on the
// port, so the absent case is a real one and gets its own test.
function providerThat(
  behaviour: { warm?: () => Promise<void> } = {},
): EmbeddingProvider & { embeds: number } {
  return {
    name: "test",
    version: "1",
    dim: 384,
    embeds: 0,
    embed(texts: string[], _role: EmbeddingRole) {
      this.embeds += texts.length;

      return Promise.resolve(texts.map(() => []));
    },
    ...(behaviour.warm ? { warm: behaviour.warm } : {}),
  };
}

function warmupOf(provider: EmbeddingProvider): ModelWarmupService {
  const scope = container.createChildContainer();

  scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: provider });

  return scope.resolve(ModelWarmupService);
}

describe("Model warm-up", () => {
  it("should load the model and report how long it took", async () => {
    // Given
    let loaded = 0;
    const provider = providerThat({
      warm: () => {
        loaded++;
        env.clock.advanceMs(624);

        return Promise.resolve();
      },
    });

    // When
    const outcome = await warmupOf(provider).warm();

    // Then
    expect(outcome).toEqual({ state: "ready", ms: 624 });
    expect(loaded).toBe(1);
    // Warming must not consume the model by embedding something.
    expect(provider.embeds).toBe(0);
  });

  it("should report ready for a provider with nothing to load", async () => {
    // Given
    const provider = providerThat();

    // When
    const outcome = await warmupOf(provider).warm();

    // Then
    expect(outcome).toEqual({ state: "ready", ms: 0 });
  });

  it("should fail open when the model cannot be loaded", async () => {
    // Given
    const provider = providerThat({
      warm: () => {
        env.clock.advanceMs(90);

        return Promise.reject(new Error("no such file: model.onnx"));
      },
    });

    // When
    const outcome = await warmupOf(provider).warm();

    // Then — the caller keeps running; the reason is carried, not thrown.
    expect(outcome).toEqual({
      state: "failed",
      ms: 90,
      error: "no such file: model.onnx",
    });
  });

  it("should still carry a reason when the failure has no message", async () => {
    // Given
    const provider = providerThat({ warm: () => Promise.reject(new Error("")) });

    // When
    const outcome = await warmupOf(provider).warm();

    // Then — an empty message must not read as "no error".
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("Error");
  });
});
