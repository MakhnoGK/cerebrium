import { injectable } from "tsyringe";
import { BackendCapabilityError, type VectorSpacesRepo } from "@/domain/ports/storage";

function refuse(): never {
  throw new BackendCapabilityError("versioned vector spaces", "sqlite");
}

@injectable()
export class SqliteVectorSpacesRepo implements VectorSpacesRepo {
  async spaces(): Promise<never> {
    return refuse();
  }

  async ensureSpace(): Promise<never> {
    return refuse();
  }

  async unembeddedChunks(): Promise<never> {
    return refuse();
  }

  async putChunkVectors(): Promise<never> {
    return refuse();
  }

  async coverage(): Promise<never> {
    return refuse();
  }

  async activate(): Promise<never> {
    return refuse();
  }
}
