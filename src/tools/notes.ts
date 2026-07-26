import type { Repo } from "@/db/repo";
import { isDaemonAlive } from "@/runtime/daemon-pid";
import { EmbeddingQueueRepo } from "@/db/repositories";

// A single write only ever adds one node to the queue, so only flag a genuine
// backlog — not the routine one-behind state right after a write.
const BACKLOG_NOTE_THRESHOLD = 20;

// context_notes about the async embedding pipeline. Parked failures always surface
// (vector search is silently incomplete until they clear); a small backlog is normal.
export function embeddingNotes(repo: EmbeddingQueueRepo): string[] {
  const { backlog, parked } = repo.embeddingStats();
  const notes: string[] = [];

  if (parked > 0) {
    notes.push(
      `${parked} memor${parked === 1 ? "y" : "ies"} failed to embed (parked); vector search is incomplete.`,
    );
  }

  if (backlog > BACKLOG_NOTE_THRESHOLD) {
    const stalled = !isDaemonAlive(repo.dbPath());

    notes.push(
      `${backlog} memories awaiting embedding — findable via text now, vectors catch up shortly.` +
        (stalled ? " No drain daemon is running; run `cerebrium-daemon` to work it off." : ""),
    );
  }

  return notes;
}
