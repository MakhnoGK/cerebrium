import { injectable } from "tsyringe";
import type { ProcessProbe } from "@/domain/ports/process-probe";
import { isProcessAlive } from "@/runtime/daemon-pid";

@injectable()
export class SystemProcessProbe implements ProcessProbe {
  alive(pid: number): boolean {
    return isProcessAlive(pid);
  }

  self(): number {
    return process.pid;
  }
}
