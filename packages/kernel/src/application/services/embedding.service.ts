import { inject, injectable } from "tsyringe";
import { EMBEDDING_QUEUE_REPO_TOKEN, type EmbeddingQueueRepo } from "@/domain/ports/storage";
import { DaemonService } from "@/application/services/daemon.service";

// A single writer only ever adds one node to the queue, so only flag a genuine
// backlog — not the routine one-behind state right after a writer.
const BACKLOG_NOTE_THRESHOLD = 20;

@injectable()
export class EmbeddingService {
  constructor(
    private readonly daemonService: DaemonService,
    @inject(EMBEDDING_QUEUE_REPO_TOKEN) private readonly embeddingQueue: EmbeddingQueueRepo,
  ) {}

  async getEmbeddingNotes() {
    const { backlog, parked } = await this.embeddingQueue.embeddingStats();
    const notes: string[] = [];

    if (parked > 0) {
      notes.push(
        `${parked} memor${parked === 1 ? "y" : "ies"} failed to embed (parked); vector search is incomplete.`,
      );
    }

    if (backlog > BACKLOG_NOTE_THRESHOLD) {
      const stalled = !this.daemonService.isDaemonAlive();

      notes.push(
        `${backlog} memories awaiting embedding — findable via text now, vectors catch up shortly.` +
          (stalled ? " No drain daemon is running; run `cerebrium-daemon` to work it off." : ""),
      );
    }

    return notes;
  }
}
