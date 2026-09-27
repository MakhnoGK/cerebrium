import type { InjectionToken } from "tsyringe";

// Whether a pid belongs to a live process. A port for the same reason Clock is one: it is
// ambient OS state, and a registry that reports liveness has to be testable without
// spawning or killing anything.
export interface ProcessProbe {
  alive(pid: number): boolean;
  self(): number;
}

export const PROCESS_PROBE_TOKEN: InjectionToken<ProcessProbe> = Symbol("ProcessProbe");
