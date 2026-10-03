import { describe, expect, it } from "vitest";
import { embeddingProfile } from "@/embeddings/profiles";

describe("embeddingProfile", () => {
  it("should keep e5's prefixes and mean pooling", () => {
    expect(embeddingProfile("Xenova/multilingual-e5-small")).toEqual({
      dim: 384,
      pooling: "mean",
      query: "query: ",
      passage: "passage: ",
    });
  });

  it("should pool each candidate the way its model was trained", () => {
    expect(embeddingProfile("Xenova/bge-m3").pooling).toBe("cls");
    expect(embeddingProfile("onnx-community/Qwen3-Embedding-0.6B-ONNX").pooling).toBe("last_token");
  });

  it("should refuse a model it has no profile for", () => {
    expect(() => embeddingProfile("some/unknown-model")).toThrow(/no embedding profile/);
  });
});
