import { createHash, randomBytes } from "node:crypto";
import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  PRINCIPAL_TOKENS_REPO_TOKEN,
  PRINCIPALS_REPO_TOKEN,
  type PrincipalsRepo,
  type PrincipalTokenRow,
  type PrincipalTokensRepo,
} from "@/domain/ports/storage";
import { newId } from "@/core/ids";

export const TOKEN_RECHECK_MS = 30_000;
const TOUCH_EVERY_MS = 60_000;
const CACHE_MAX = 1_000;
const TOKEN_PREFIX = "cbr_";

export interface IssuedToken {
  id: string;
  principal: string;
  label: string;
  token: string;
}

export interface AuthenticatedToken {
  principal: string;
  token_id: string;
}

interface Cached {
  hit: AuthenticatedToken | null;
  checkedAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

@injectable()
export class PrincipalTokenService {
  private readonly cache = new Map<string, Cached>();
  private readonly touched = new Map<string, number>();

  constructor(
    @inject(PRINCIPAL_TOKENS_REPO_TOKEN) private readonly tokens: PrincipalTokensRepo,
    @inject(PRINCIPALS_REPO_TOKEN) private readonly principals: PrincipalsRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async issue(principal: string, label: string): Promise<IssuedToken> {
    const ts = this.clock.now();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const id = newId();

    await this.principals.resolve({ client: principal, version: null, principal }, ts);
    await this.tokens.insert(
      { id, principal_id: principal, label, created_at: ts },
      hashToken(token),
    );

    return { id, principal, label, token };
  }

  list(): Promise<PrincipalTokenRow[]> {
    return this.tokens.list();
  }

  async revoke(id: string): Promise<boolean> {
    return this.tokens.revoke(id, this.clock.now());
  }

  // Answers from memory for TOKEN_RECHECK_MS, so a revocation reaches a held connection
  // within that window.
  async authenticate(token: string): Promise<AuthenticatedToken | null> {
    const hash = hashToken(token);
    const now = Date.parse(this.clock.now());
    const cached = this.cache.get(hash);

    if (cached !== undefined && now - cached.checkedAt < TOKEN_RECHECK_MS) return cached.hit;

    const row = await this.tokens.findActiveByHash(hash);
    const hit = row === undefined ? null : { principal: row.principal_id, token_id: row.id };

    if (this.cache.size >= CACHE_MAX) this.cache.clear();

    this.cache.set(hash, { hit, checkedAt: now });

    if (row !== undefined) await this.touch(row, now);

    return hit;
  }

  private async touch(row: PrincipalTokenRow, now: number): Promise<void> {
    const last = this.touched.get(row.id) ?? (row.last_used_at ? Date.parse(row.last_used_at) : 0);

    if (now - last < TOUCH_EVERY_MS) return;

    this.touched.set(row.id, now);
    await this.tokens.touch(row.id, new Date(now).toISOString());
  }
}
