import type { EventAction } from "@cerebrium/contracts/vocab";
import type { Writer } from "@/domain/writer";

export const SESSIONS_REPO_TOKEN = Symbol("SessionsRepo");

export interface SessionsRepo {
  create(
    id: string,
    project: string | null,
    ts: string,
    writer: Writer,
    principal_id: string,
  ): Promise<void>;
  principalOf(id: string): Promise<string | null>;
  touchExisting(id: string, ts: string): Promise<boolean>;
  logEvent(
    action: EventAction,
    session_id: string,
    node_id: string | null,
    detail: unknown,
    ts: string,
  ): Promise<void>;
}
