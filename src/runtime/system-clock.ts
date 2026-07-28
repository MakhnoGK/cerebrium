import { injectable } from "tsyringe";
import { type Clock } from "@/domain/ports/clock";

@injectable()
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
