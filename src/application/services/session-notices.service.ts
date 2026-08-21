import { singleton } from "tsyringe";

// Sessions whose figure is remembered. A resident daemon would otherwise hold one entry
// per session it has ever served.
const REMEMBERED_SESSIONS = 64;

// What each session has already been told, so a hint asked for on every tool call does not
// repeat itself. Holds no database handle deliberately: it is the one part that has to
// outlive a container, and everything DB-backed stays per-container.
@singleton()
export class SessionNotices {
  private readonly told = new Map<string, number>();

  // True the first time a session sees a figure, and again whenever it changes.
  isNews(sessionId: string, figure: number): boolean {
    if (this.told.get(sessionId) === figure) return false;

    if (this.told.size >= REMEMBERED_SESSIONS) this.told.clear();

    this.told.set(sessionId, figure);

    return true;
  }
}
