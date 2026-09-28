import { injectable } from "tsyringe";
import {
  BackendCapabilityError,
  type PrincipalTokenRow,
  type PrincipalTokensRepo,
} from "@/domain/ports/storage";

@injectable()
export class SqlitePrincipalTokensRepo implements PrincipalTokensRepo {
  private refuse(): never {
    throw new BackendCapabilityError("principal tokens", "sqlite");
  }

  async insert(): Promise<void> {
    this.refuse();
  }

  async findActiveByHash(): Promise<PrincipalTokenRow | undefined> {
    this.refuse();
  }

  async list(): Promise<PrincipalTokenRow[]> {
    this.refuse();
  }

  async revoke(): Promise<boolean> {
    this.refuse();
  }

  async touch(): Promise<void> {
    this.refuse();
  }
}
