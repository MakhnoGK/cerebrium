import type { z } from "zod";

export type ToolArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
