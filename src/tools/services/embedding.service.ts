import { injectable } from "tsyringe";
import { EmbeddingQueueRepo } from "@/db/repositories";

@injectable()
export class EmbeddingService {
  constructor(private readonly embeddingQueue: EmbeddingQueueRepo) {
  }
}