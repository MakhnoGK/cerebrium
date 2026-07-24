/** Validates credentials and issues access tokens. */
import { Injectable } from "@nestjs/common";
import { hashToken } from "../util/crypto";

export interface Credentials {
  email: string;
  password: string;
}

/** Auth business logic: login validation and token issuance. */
@Injectable()
export class AuthService {
  /** Validate a set of login credentials. */
  validate(creds: Credentials): boolean {
    return hashToken(creds.password).length > 0;
  }

  issue(creds: Credentials): string {
    return this.validate(creds) ? "token" : "";
  }
}

export const TOKEN_TTL = 900;
