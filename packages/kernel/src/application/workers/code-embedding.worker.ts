import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import {
  BRANCH_CODE_REPO_TOKEN,
  STORE_TOKEN,
  type BranchCodeRepo,
  type Store,
} from "@/domain/ports/storage";

const BATCH = 32;

// Embeds symbol summaries of the per-branch index that live on some branch and have no
// vector in the active space yet. A vector is keyed by the text, so an unchanged symbol in a
// new parse of its file costs nothing.
@injectable()
export class CodeEmbeddingWorker {
  private failures = 0;
  private resumeAt = 0;

  constructor(
    @inject(BRANCH_CODE_REPO_TOKEN) private readonly code: BranchCodeRepo,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    @inject(STORE_TOKEN) private readonly store: Store,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async tick(): Promise<{ embedded: number; failed: boolean }> {
    if (!this.store.capabilities.branchCode) return { embedded: 0, failed: false };

    const now = Date.parse(this.clock.now());

    if (now < this.resumeAt) return { embedded: 0, failed: false };

    const pending = await this.code.pendingEmbeddings(BATCH);

    if (!pending.length) return { embedded: 0, failed: false };

    try {
      const vectors = await this.provider.embed(
        pending.map((p) => p.text),
        EmbeddingRole.PASSAGE,
      );

      await this.code.commitVectors(
        pending.map((p, i) => ({ embed_hash: p.embed_hash, vector: vectors[i]! })),
        this.provider.name,
        this.provider.version,
        this.clock.now(),
      );
      this.failures = 0;

      return { embedded: pending.length, failed: false };
    } catch (err) {
      this.failures++;
      this.resumeAt = now + Math.min(1000 * 2 ** (this.failures - 1), 60_000);
      process.stderr.write(`code embeddings: ${(err as Error).message}\n`);

      return { embedded: 0, failed: true };
    }
  }

  backlog(): Promise<number> {
    return this.store.capabilities.branchCode ? this.code.embeddingBacklog() : Promise.resolve(0);
  }
}
