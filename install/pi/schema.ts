// Cerebrium's tool schemas are draft-07 JSON Schema; pi hands a tool's `parameters`
// straight to whichever provider is loaded. The keywords below are the subset every
// provider in pi accepts — `$schema`, `additionalProperties` and `pattern` are dropped
// because Google's API rejects them, and the constraint they carried is already spelled
// out in each field's description.

export const TOOL_PREFIX = "cerebrium_";

const KEPT_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "default",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "anyOf",
  "oneOf",
]);

const EMPTY_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

/** `write`, `read` and `get` are built-in pi tools; every memory tool takes a prefix. */
export function piToolName(mcpName: string): string {
  return `${TOOL_PREFIX}${mcpName}`;
}

export function mcpToolName(piName: string): string | null {
  return piName.startsWith(TOOL_PREFIX) ? piName.slice(TOOL_PREFIX.length) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((node, segment) => {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      return isRecord(node) ? node[key] : undefined;
    }, document);
}

/**
 * `link` declares `dst` as `$ref: "#/properties/src"`. Dropping the keyword would leave the
 * model an argument with no description, so local pointers are inlined before the whitelist
 * runs. The depth guard is what stops a self-referencing schema from spinning.
 */
function inlineRefs(node: unknown, document: Record<string, unknown>, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, document, depth));
  if (!isRecord(node)) return node;

  const ref = node.$ref;
  if (typeof ref === "string" && depth < 8) {
    const target = pointer(document, ref);
    if (target !== undefined) {
      const { $ref: _dropped, ...rest } = node;
      return inlineRefs({ ...(isRecord(target) ? target : {}), ...rest }, document, depth + 1);
    }
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inlineRefs(value, document, depth)]),
  );
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (key === "properties" && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, schema]) => [name, sanitizeNode(schema)]),
    );
  }
  if (key === "items" || key === "anyOf" || key === "oneOf") {
    return Array.isArray(value) ? value.map(sanitizeNode) : sanitizeNode(value);
  }
  return value;
}

function sanitizeNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => KEPT_KEYWORDS.has(key))
      .map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
}

/** Providers require an object schema; a tool that declares nothing gets an empty one. */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const inlined = isRecord(schema) ? inlineRefs(schema, schema) : schema;
  const sanitized = sanitizeNode(inlined);
  if (!isRecord(sanitized) || sanitized.type !== "object") return { ...EMPTY_SCHEMA };
  return { ...sanitized, properties: isRecord(sanitized.properties) ? sanitized.properties : {} };
}

export function acceptsSessionId(schema: unknown): boolean {
  const sanitized = sanitizeSchema(schema);
  return isRecord(sanitized.properties) && "session_id" in sanitized.properties;
}

/**
 * The extension holds the id `session_start` returned, so an omitted one is filled rather
 * than bounced back at the model. An id the model did supply is left alone — arbitrating
 * between two ids is the server's job, not ours.
 */
export function withSessionId(
  args: Record<string, unknown>,
  sessionId: string | null,
  schema: unknown,
): Record<string, unknown> {
  if (sessionId === null || !acceptsSessionId(schema)) return args;
  const current = args.session_id;
  if (typeof current === "string" && current !== "") return args;
  return { ...args, session_id: sessionId };
}
