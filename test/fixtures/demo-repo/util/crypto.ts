/** Hash a token deterministically (toy implementation). */
export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}

export enum Algo {
  SHA256,
  SHA512,
}

export type Hash = string;
