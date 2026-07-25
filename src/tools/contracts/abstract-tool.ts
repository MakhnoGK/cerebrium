import { TypeOf, z, ZodObject } from "zod";
import { ToolName } from "./tool-name";
import type { Context } from "@/core/context";

export abstract class AbstractTool {
  public abstract name: ToolName;
  public abstract description: string;
  public abstract schema: z.ZodRawShape;

  constructor(protected readonly ctx: Context) {}

  abstract invoke(args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown>;

  public async callback(args: z.infer<z.ZodObject<z.ZodRawShape>>) {
    return this.invoke(args)
      .then((data) => ({
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      }))
      .catch((reason: unknown) => ({
        isError: true as const,
        content: [{ type: "text" as const, text: (reason as Error).message }],
      }));
  }
}
