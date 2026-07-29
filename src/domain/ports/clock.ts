export const CLOCK_TOKEN = Symbol("Clock");

export interface Clock {
  now(): string;
}
