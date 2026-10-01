import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import { EventAction, MemoryKind } from "@cerebrium/contracts/vocab";
import { CallPipeline } from "@/application/call-pipeline";
import { ActivityFeed } from "@/application/services";
import type { RecentActivityResult } from "@/application/use-cases";
import type { Writer } from "@/runtime/client-identity";
import { setup } from "@test/helpers";

const WRITER: Writer = { client: "dash-test", version: "1" };

let pipeline: CallPipeline;
let session: string;
let heard: ActivityEntry[];
let unlisten: () => void = () => undefined;

function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  return pipeline.invoke(container, name, args, WRITER);
}

function write(title: string): Promise<unknown> {
  return call("write_memory", {
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    project: null,
    title,
    content: `${title}: a fact with enough words in it to make a chunk worth embedding`,
  });
}

beforeEach(async () => {
  setup();
  pipeline = container.resolve(CallPipeline);
  session = ((await call("start_session", {})) as { session_id: string }).session_id;
  heard = [];
  unlisten = container.resolve(ActivityFeed).listen((entry) => heard.push(entry));
});

afterEach(() => {
  unlisten();
});

describe("The activity feed", () => {
  it("should hear every audited call as it is recorded, with who made it", async () => {
    // When
    const written = (await write("First")) as { envelope: { id: string } };

    // Then
    expect(heard).toEqual([
      expect.objectContaining({
        action: EventAction.WRITE,
        session_id: session,
        node_id: written.envelope.id,
        principal: "dash-test",
        client: "dash-test",
        ok: true,
      }),
    ]);
  });

  it("should mark a call that failed", async () => {
    // When
    await call("update_memory", { session_id: session, id: "01M3W00000000000000000000Z" }).catch(
      () => undefined,
    );

    // Then
    expect(heard.filter((e) => (e.action as EventAction) === EventAction.UPDATE)).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
  });

  it("should not hear a read of the log itself", async () => {
    // When
    await call("recent_activity", {});

    // Then
    expect(heard).toEqual([]);
  });
});

describe("Recent activity", () => {
  it("should list events newest first with their client, and page back from a point", async () => {
    // Given
    await write("First");
    await write("Second");
    await write("Third");

    // When
    const page = (await call("recent_activity", { limit: 2 })) as RecentActivityResult;
    const older = (await call("recent_activity", {
      before: page.events[1]!.ts,
    })) as RecentActivityResult;

    // Then
    expect(page.events).toHaveLength(2);
    expect(page.events[0]!.ts >= page.events[1]!.ts).toBe(true);
    expect(page.events[0]).toMatchObject({ action: EventAction.WRITE, client: "dash-test" });
    expect(older.events.every((e) => e.ts < page.events[1]!.ts)).toBe(true);
    expect(older.runs).toEqual([]);
  });
});
