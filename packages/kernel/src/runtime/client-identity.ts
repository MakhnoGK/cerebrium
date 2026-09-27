import { singleton } from "tsyringe";
import { UNKNOWN_WRITER, type Writer } from "@/domain/writer";

export { UNKNOWN_WRITER, type Writer };

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
