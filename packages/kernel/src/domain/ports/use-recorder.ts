export const USE_RECORDER_TOKEN = Symbol("UseRecorder");

// Reading a node counts as using it: `use_count` feeds the bounded ranking boost and
// `last_used_at` restarts an episodic node's decay clock. This is the one write a read
// performs, so it is addressed as a port — a host without a writable handle binds a
// recorder that does nothing and whoever dispatched the read records it instead.
export interface UseRecorder {
  recordUse(ids: string[], ts: string): void;
}
