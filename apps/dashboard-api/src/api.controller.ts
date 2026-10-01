import { Controller, Get, Inject, Query, Sse, type MessageEvent } from "@nestjs/common";
import { from, interval, map, merge, startWith, switchMap, type Observable } from "rxjs";
import type { ActivityPage, DashboardStatus } from "@cerebrium/contracts/dashboard";
import type { GraphSnapshot } from "@cerebrium/contracts/graph";
import { KernelClient } from "./kernel.client";
import { StatusService } from "./status.service";

const STATUS_EVERY_MS = 5_000;
const GRAPH_TIMEOUT_MS = 30_000;

@Controller("api")
export class ApiController {
  constructor(
    @Inject(KernelClient) private readonly kernel: KernelClient,
    @Inject(StatusService) private readonly statusService: StatusService,
  ) {}

  @Get("status")
  status(): Promise<DashboardStatus> {
    return this.statusService.status();
  }

  @Get("activity")
  activity(
    @Query("limit") limit?: string,
    @Query("before") before?: string,
  ): Promise<ActivityPage> {
    const n = Number(limit);

    return this.kernel.call<ActivityPage>("recent_activity", {
      ...(Number.isInteger(n) && n > 0 ? { limit: n } : {}),
      ...(before ? { before } : {}),
    });
  }

  @Get("graph")
  graph(
    @Query("invalidated") invalidated?: string,
    @Query("symbols") symbols?: string,
  ): Promise<GraphSnapshot> {
    return this.kernel.call<GraphSnapshot>(
      "graph_snapshot",
      { invalidated: invalidated === "1", symbols: symbols === "1" },
      GRAPH_TIMEOUT_MS,
    );
  }

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    const status = interval(STATUS_EVERY_MS).pipe(
      startWith(0),
      switchMap(() => from(this.statusService.status())),
      map((data): MessageEvent => ({ type: "status", data })),
    );
    const notices = this.kernel.notices.pipe(
      map((notice): MessageEvent => ({ type: notice.type, data: notice.data })),
    );

    return merge(status, notices);
  }
}
