import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import type {
  CandidateDecisionBody,
  CandidateDecisionResult,
  CandidatePage,
  ReviewDecisionBody,
  ReviewDecisionResult,
  ReviewPage,
} from "@cerebrium/contracts/dashboard";
import { ReviewService } from "./review.service";

const KINDS = ["distill", "merge", "link", "prune", "documents", "supersede"];

// Request bodies arrive as whatever the browser sent, whatever the parameter type says.
function oneOf(value: unknown, allowed: string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

// The kernel's refusal is the useful part of a failed decision ("already applied", "has no
// proposal"), so it is passed to the browser as the message.
async function relayed<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw new BadRequestException((err as Error).message.replace(/^\w+ failed: /, ""));
  }
}

@Controller("api")
export class ReviewController {
  constructor(@Inject(ReviewService) private readonly review: ReviewService) {}

  @Get("consolidation/candidates")
  candidates(
    @Query("kind") kind?: string,
    @Query("cursor") cursor?: string,
  ): Promise<CandidatePage> {
    if (kind && !KINDS.includes(kind)) throw new BadRequestException(`unknown kind ${kind}`);

    return relayed(this.review.candidates(kind, cursor));
  }

  @Post("consolidation/candidates/:id/decision")
  @HttpCode(200)
  decide(
    @Param("id") id: string,
    @Body() body: CandidateDecisionBody,
  ): Promise<CandidateDecisionResult> {
    if (!oneOf(body.decision, ["apply", "reject"])) {
      throw new BadRequestException("decision is apply or reject");
    }

    return relayed(this.review.decide(id, body));
  }

  @Post("consolidation/candidates/:id/retry")
  @HttpCode(200)
  retry(@Param("id") id: string): Promise<{ status: string }> {
    return relayed(this.review.retry(id));
  }

  @Get("reviews")
  reviews(): Promise<ReviewPage> {
    return relayed(this.review.reviews());
  }

  @Post("reviews/decision")
  @HttpCode(200)
  resolve(@Body() body: ReviewDecisionBody): Promise<ReviewDecisionResult> {
    if (!oneOf(body.decision, ["kept", "undone"])) {
      throw new BadRequestException("decision is kept or undone");
    }

    return relayed(this.review.resolve(body));
  }
}
