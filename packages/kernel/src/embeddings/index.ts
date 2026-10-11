import { type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { HttpProvider } from "@/embeddings/http";
import { LocalProvider } from "@/embeddings/local";
import { LocalNullProvider } from "@/embeddings/local-null";

// Provider chosen by env at startup. Adding a paid/cloud provider is a one-file
// change here plus a class — the interface is the whole contract.
export function createProvider(
  name = "local",
  model?: string,
  cacheDir?: string,
  remote?: { url?: string; timeoutMs?: number; batchSize?: number },
): EmbeddingProvider {
  return name === "local-null"
    ? new LocalNullProvider()
    : name === "http"
      ? new HttpProvider({ ...remote, ...(model === undefined ? {} : { model }) })
      : new LocalProvider(model, cacheDir);
}
