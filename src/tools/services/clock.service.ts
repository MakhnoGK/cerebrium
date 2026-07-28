import { injectable } from "tsyringe";

export const CLOCK_TOKEN = Symbol("Clock");

export interface Clock {
  now(): string;
}

@injectable()
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
