import type { UseRecorder } from "@/domain/ports/use-recorder";

export class NoUseRecorder implements UseRecorder {
  async recordUse(): Promise<void> {
    return;
  }
}
