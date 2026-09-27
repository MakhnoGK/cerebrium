import { singleton } from "tsyringe";

export interface Writer {
  client: string | null;
  version: string | null;
}

export const UNKNOWN_WRITER: Writer = { client: null, version: null };

// Who is writing: the MCP `initialize` handshake names external clients, internal
// writers name themselves. Populated once per process, before any tool call.
@singleton()
export class ClientIdentity {
  private writer: Writer = UNKNOWN_WRITER;

  public set(writer: Writer): void {
    this.writer = writer;
  }

  public get(): Writer {
    return this.writer;
  }
}
