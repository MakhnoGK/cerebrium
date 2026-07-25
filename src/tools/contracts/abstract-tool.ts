import type { Ctx } from "@/tools/context";
import { z } from "zod";
import { ToolName } from "./tool-name";

export abstract class AbstractTool {
  public abstract name: ToolName;
  public abstract description: string;
  public abstract schema: z.ZodRawShape;

  protected abstract invoke(
    ctx: Ctx,
    args: z.infer<z.ZodObject<typeof this.schema>>,
  ): Promise<unknown>;

  public async callback(ctx: Ctx, args: z.infer<z.ZodObject<z.ZodRawShape>>) {
    return this.invoke(ctx, args)
      .then((data) => ({
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      }))
      .catch((reason: unknown) => ({
        isError: true as const,
        content: [{ type: "text" as const, text: (reason as Error).message }],
      }));
  }
}
