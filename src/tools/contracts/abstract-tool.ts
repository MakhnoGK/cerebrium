import { TypeOf, z, ZodObject } from "zod";
import { ToolName } from "./tool-name";
import type { Context } from "@/core/context";

export abstract class AbstractTool {
  public abstract name: ToolName;
  public abstract description: string;
  public abstract schema: z.ZodRawShape;

  constructor(protected readonly ctx: Context) {}

  abstract invoke(args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown>;
}
