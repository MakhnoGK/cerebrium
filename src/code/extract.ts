import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import type { ExtractedSymbol } from "@/db/repo";

// Per-file extraction result. Symbols become mirror nodes; defines are local
// (container -> member) and resolvable immediately; imports/calls carry enough to be
// resolved against the whole-repo symbol directory in the indexer's second pass.
export interface ImportRef {
  name: string; // imported binding name; for namespace/default, the target module is used
  candidatePaths: string[]; // repo-relative candidate file paths the specifier may resolve to
  namespace: boolean; // `* as X` / default import -> link module -> target module
  byName?: boolean; // no path resolution available (e.g. PHP `use`) -> resolve by symbol name repo-wide
}

export interface CallRef {
  srcQualified: string; // enclosing symbol (or the module) that makes the call
  callee: string; // simple callee name (identifier or member property)
}

export interface FileExtract {
  symbols: ExtractedSymbol[];
  defines: { src: string; dst: string }[]; // external ids
  imports: ImportRef[];
  calls: CallRef[];
  moduleExternalId: string;
}

const SIG_MAX = 200;
const CODE_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

export function stableSymbolId(
  repo: string,
  path: string,
  qualified: string,
  kind: string,
): string {
  return createHash("sha256")
    .update(`${repo}\0${path}\0${qualified}\0${kind}`)
    .digest("hex")
    .slice(0, 24);
}

function sha24(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cap(s: string): string {
  return s.length > SIG_MAX ? s.slice(0, SIG_MAX).trimEnd() + "…" : s;
}

const named = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c != null);

// Signature = the declaration text up to the start of its body (function/class body),
// else the first line. Whitespace-collapsed and capped — deterministic, no LLM.
function signatureOf(node: Node, body: Node | null): string {
  const full = node.text;
  if (body) {
    const marker = body.text.slice(0, 24);
    const idx = marker ? full.lastIndexOf(marker) : -1;
    if (idx > 0) return cap(oneLine(full.slice(0, idx)));
  }
  const nl = full.indexOf("\n");
  return cap(oneLine(nl === -1 ? full : full.slice(0, nl)));
}

function docFromComment(comment: Node): string | null {
  let t = comment.text.trim();
  if (t.startsWith("/*")) t = t.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
  const lines = t
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*\*+\s?/, "")
        .replace(/^\s*\/\/+\s?/, "")
        .replace(/^!\s?/, "") // Rust inner-doc marker (`//!` / `/*!`)
        .trim(),
    )
    .filter(Boolean);
  return lines[0] ?? null;
}

// First meaningful line of the doc-comment immediately preceding `node`, if any.
function docFor(node: Node): string | null {
  const prev = node.previousSibling;
  if (prev?.type !== "comment") return null;
  return docFromComment(prev);
}

function summaryOf(signature: string, doc: string | null): string {
  return doc ? `${signature}\n${doc}` : signature;
}

// A `const`/`let`/`var` initializer that is really a function -> still `const` per the
// vocab, but it gets a body for call extraction and a nicer signature.
function fnBodyOf(value: Node | null): Node | null {
  if (!value) return null;
  if (
    value.type === "arrow_function" ||
    value.type === "function_expression" ||
    value.type === "function"
  ) {
    return value.childForFieldName("body");
  }
  return null;
}

interface Ctx {
  repo: string;
  path: string;
  symbols: ExtractedSymbol[];
  defines: { src: string; dst: string }[];
  calls: CallRef[];
  seenExt: Set<string>;
}

function push(
  ctx: Ctx,
  kind: string,
  name: string,
  qualified: string,
  node: Node,
  body: Node | null,
  doc: string | null,
  source?: string,
): string {
  const signature = signatureOf(node, body);
  const src = source ?? node.text;
  const ext = stableSymbolId(ctx.repo, ctx.path, qualified, kind);
  if (!ctx.seenExt.has(ext)) {
    ctx.seenExt.add(ext);
    ctx.symbols.push({
      external_id: ext,
      symbol_kind: kind,
      name,
      qualified,
      signature,
      summary: summaryOf(signature, doc),
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      code_hash: sha24(src),
      source: src,
    });
  }
  return ext;
}

// Record every call inside a symbol's body subtree, attributed to that symbol. Nested
// closures are attributed to the enclosing symbol too — best-effort, intra-repo only.
function collectCalls(ctx: Ctx, srcQualified: string, body: Node | null): void {
  if (!body) return;
  for (const call of body.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    let callee: string | null = null;
    if (fn.type === "identifier") callee = fn.text;
    else if (fn.type === "member_expression")
      callee = fn.childForFieldName("property")?.text ?? null;
    if (callee) ctx.calls.push({ srcQualified, callee });
  }
}

function nameOf(node: Node): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

// Unwrap `export …` / `export default …` to the underlying declaration.
function declOf(node: Node): Node {
  if (node.type === "export_statement") {
    return node.childForFieldName("declaration") ?? node.childForFieldName("value") ?? node;
  }
  return node;
}

function handleClass(ctx: Ctx, node: Node, moduleExt: string, doc: string | null): void {
  const name = nameOf(node);
  if (!name) return;
  const qualified = `${ctx.path}:${name}`;
  const body = node.childForFieldName("body");
  const classExt = push(ctx, "class", name, qualified, node, body, doc);
  ctx.defines.push({ src: moduleExt, dst: classExt });
  if (!body) return;
  for (const member of named(body)) {
    if (member.type !== "method_definition") continue;
    const mName = nameOf(member);
    if (!mName) continue;
    const mQual = `${qualified}.${mName}`;
    const mBody = member.childForFieldName("body");
    const mExt = push(ctx, "method", mName, mQual, member, mBody, docFor(member));
    ctx.defines.push({ src: classExt, dst: mExt });
    collectCalls(ctx, mQual, mBody);
  }
}

function handleTopLevel(ctx: Ctx, stmt: Node, moduleExt: string): void {
  const decl = declOf(stmt);
  const doc = docFor(stmt); // comment precedes the (possibly exported/decorated) statement
  switch (decl.type) {
    case "class_declaration":
    case "abstract_class_declaration":
      handleClass(ctx, decl, moduleExt, doc);
      return;
    case "function_declaration":
    case "generator_function_declaration": {
      const name = nameOf(decl);
      if (!name) return;
      const qualified = `${ctx.path}:${name}`;
      const body = decl.childForFieldName("body");
      const ext = push(ctx, "function", name, qualified, decl, body, doc);
      ctx.defines.push({ src: moduleExt, dst: ext });
      collectCalls(ctx, qualified, body);
      return;
    }
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = nameOf(decl);
      if (!name) return;
      const kind =
        decl.type === "interface_declaration"
          ? "interface"
          : decl.type === "enum_declaration"
            ? "enum"
            : "type";
      const body = decl.childForFieldName("body");
      const ext = push(ctx, kind, name, `${ctx.path}:${name}`, decl, body, doc);
      ctx.defines.push({ src: moduleExt, dst: ext });
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      for (const d of named(decl)) {
        if (d.type !== "variable_declarator") continue;
        const name = d.childForFieldName("name")?.text;
        if (!name) continue;
        const value = d.childForFieldName("value");
        const body = fnBodyOf(value);
        const qualified = `${ctx.path}:${name}`;
        // The whole declaration is the source slice so a re-export/const reads sensibly.
        const ext = push(ctx, "const", name, qualified, d, body, doc, decl.text);
        ctx.defines.push({ src: moduleExt, dst: ext });
        collectCalls(ctx, qualified, body);
      }
      return;
    }
    case "expression_statement":
      collectCalls(ctx, ctx.path, decl); // top-level call attributed to the module
      return;
  }
}

// Resolve an import specifier to candidate repo-relative file paths. Bare/aliased
// specifiers (no leading '.') resolve to nothing -> their edges are dropped.
function candidatePaths(fromPath: string, spec: string): string[] {
  if (!spec.startsWith(".")) return [];
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec)).replace(/\/$/, "");
  const out: string[] = [];
  const hasExt = CODE_EXTS.some((e) => base.endsWith(e));
  if (hasExt) out.push(base);
  for (const e of CODE_EXTS) out.push(base + e);
  for (const e of CODE_EXTS) out.push(`${base}/index${e}`);
  return [...new Set(out)];
}

function handleImport(node: Node, fromPath: string): ImportRef[] {
  const source = node.childForFieldName("source")?.text.replace(/['"]/g, "");
  if (!source) return [];
  const candidates = candidatePaths(fromPath, source);
  if (!candidates.length) return [];
  const clause = named(node).find((c) => c.type === "import_clause");
  if (!clause) return []; // side-effect import
  const refs: ImportRef[] = [];
  for (const part of named(clause)) {
    if (part.type === "named_imports") {
      for (const spec of named(part)) {
        if (spec.type !== "import_specifier") continue;
        const name = spec.childForFieldName("name")?.text;
        if (name) refs.push({ name, candidatePaths: candidates, namespace: false });
      }
    } else if (part.type === "namespace_import" || part.type === "identifier") {
      refs.push({ name: source, candidatePaths: candidates, namespace: true });
    }
  }
  return refs;
}

export function extractFile(
  repo: string,
  path: string,
  lang: string,
  source: string,
  root: Node,
): FileExtract {
  if (lang === "php") return extractPhp(repo, path, source, root);
  if (lang === "rust") return extractRust(repo, path, source, root);
  return extractTsJs(repo, path, source, root);
}

function extractTsJs(repo: string, path: string, source: string, root: Node): FileExtract {
  const moduleName = posix.basename(path);
  const moduleQualified = path;
  const moduleExt = stableSymbolId(repo, path, moduleQualified, "module");

  const ctx: Ctx = { repo, path, symbols: [], defines: [], calls: [], seenExt: new Set() };
  // The module symbol: its source is the whole file; its summary is compact.
  const first = root.namedChild(0);
  const fileDoc = first?.type === "comment" ? docFromComment(first) : null;
  const moduleSig = `module ${moduleQualified}`;
  ctx.symbols.push({
    external_id: moduleExt,
    symbol_kind: "module",
    name: moduleName,
    qualified: moduleQualified,
    signature: moduleSig,
    summary: summaryOf(moduleSig, fileDoc),
    start_line: 1,
    end_line: root.endPosition.row + 1,
    code_hash: sha24(source),
    source,
  });
  ctx.seenExt.add(moduleExt);

  const imports: ImportRef[] = [];
  for (const stmt of named(root)) {
    if (stmt.type === "import_statement") imports.push(...handleImport(stmt, path));
    else handleTopLevel(ctx, stmt, moduleExt);
  }

  return {
    symbols: ctx.symbols,
    defines: ctx.defines,
    imports,
    calls: ctx.calls,
    moduleExternalId: moduleExt,
  };
}

// ---- PHP -------------------------------------------------------------------

const PHP_CALL_TYPES = [
  "function_call_expression",
  "member_call_expression",
  "nullsafe_member_call_expression",
  "scoped_call_expression",
];

function calleePhp(call: Node): string | null {
  if (call.type === "function_call_expression") {
    const fn = call.childForFieldName("function") ?? call.namedChild(0);
    if (!fn) return null;
    if (fn.type === "name") return fn.text;
    if (fn.type === "qualified_name") {
      const names = fn.descendantsOfType("name").filter((n): n is Node => n != null);
      return names.length ? names[names.length - 1]!.text : null;
    }
    return null;
  }
  return call.childForFieldName("name")?.text ?? null; // member / nullsafe / scoped
}

function collectCallsPhp(ctx: Ctx, srcQualified: string, body: Node | null): void {
  if (!body) return;
  for (const call of body.descendantsOfType(PHP_CALL_TYPES)) {
    if (!call) continue;
    const callee = calleePhp(call);
    if (callee) ctx.calls.push({ srcQualified, callee });
  }
}

// PHP `use App\Util\Hasher [as X];` -> the imported binding's short name. Resolution
// is by-name repo-wide (PSR-4 namespace->file mapping needs composer autoload config,
// out of scope), so no path candidates are computed.
function handlePhpUse(node: Node): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const clause of node.descendantsOfType("namespace_use_clause")) {
    if (!clause) continue;
    const names = clause.descendantsOfType("name").filter((n): n is Node => n != null);
    const name = names.length ? names[names.length - 1]!.text : undefined; // alias, if any, is last
    if (name) refs.push({ name, candidatePaths: [], namespace: false, byName: true });
  }
  return refs;
}

function phpBody(node: Node): Node | null {
  return (
    named(node).find((c) => c.type === "declaration_list" || c.type === "enum_declaration_list") ??
    null
  );
}

function handlePhpMembers(
  ctx: Ctx,
  body: Node | null,
  ownerExt: string,
  ownerQualified: string,
): void {
  if (!body) return;
  for (const member of named(body)) {
    if (member.type !== "method_declaration") continue;
    const mName = nameOf(member);
    if (!mName) continue;
    const mQual = `${ownerQualified}.${mName}`;
    const mBody = named(member).find((c) => c.type === "compound_statement") ?? null;
    const mExt = push(ctx, "method", mName, mQual, member, mBody, docFor(member));
    ctx.defines.push({ src: ownerExt, dst: mExt });
    collectCallsPhp(ctx, mQual, mBody);
  }
}

function phpTopLevel(ctx: Ctx, stmt: Node, moduleExt: string, imports: ImportRef[]): void {
  const doc = docFor(stmt);
  switch (stmt.type) {
    case "namespace_use_declaration":
      imports.push(...handlePhpUse(stmt));
      return;
    case "namespace_definition": {
      // Braced `namespace App { … }` -> its body holds the declarations.
      const block = named(stmt).find(
        (c) => c.type === "compound_statement" || c.type === "declaration_list",
      );
      if (block) for (const s of named(block)) phpTopLevel(ctx, s, moduleExt, imports);
      return;
    }
    case "class_declaration":
    case "trait_declaration":
    case "enum_declaration": {
      const name = nameOf(stmt);
      if (!name) return;
      const kind =
        stmt.type === "trait_declaration"
          ? "trait"
          : stmt.type === "enum_declaration"
            ? "enum"
            : "class";
      const qualified = `${ctx.path}:${name}`;
      const body = phpBody(stmt);
      const ext = push(ctx, kind, name, qualified, stmt, body, doc);
      ctx.defines.push({ src: moduleExt, dst: ext });
      handlePhpMembers(ctx, body, ext, qualified);
      return;
    }
    case "interface_declaration": {
      const name = nameOf(stmt);
      if (!name) return;
      const ext = push(ctx, "interface", name, `${ctx.path}:${name}`, stmt, phpBody(stmt), doc);
      ctx.defines.push({ src: moduleExt, dst: ext });
      return;
    }
    case "function_definition": {
      const name = nameOf(stmt);
      if (!name) return;
      const qualified = `${ctx.path}:${name}`;
      const body = named(stmt).find((c) => c.type === "compound_statement") ?? null;
      const ext = push(ctx, "function", name, qualified, stmt, body, doc);
      ctx.defines.push({ src: moduleExt, dst: ext });
      collectCallsPhp(ctx, qualified, body);
      return;
    }
    case "const_declaration": {
      for (const el of named(stmt)) {
        if (el.type !== "const_element") continue;
        const name =
          el.childForFieldName("name")?.text ?? named(el).find((c) => c.type === "name")?.text;
        if (!name) continue;
        const ext = push(ctx, "const", name, `${ctx.path}:${name}`, el, null, doc, stmt.text);
        ctx.defines.push({ src: moduleExt, dst: ext });
      }
      return;
    }
    case "expression_statement":
      collectCallsPhp(ctx, ctx.path, stmt); // top-level call attributed to the module
      return;
  }
}

function extractPhp(repo: string, path: string, source: string, root: Node): FileExtract {
  const moduleQualified = path;
  const moduleExt = stableSymbolId(repo, path, moduleQualified, "module");
  const ctx: Ctx = { repo, path, symbols: [], defines: [], calls: [], seenExt: new Set() };
  const moduleSig = `module ${moduleQualified}`;
  ctx.symbols.push({
    external_id: moduleExt,
    symbol_kind: "module",
    name: posix.basename(path),
    qualified: moduleQualified,
    signature: moduleSig,
    summary: moduleSig,
    start_line: 1,
    end_line: root.endPosition.row + 1,
    code_hash: sha24(source),
    source,
  });
  ctx.seenExt.add(moduleExt);

  const imports: ImportRef[] = [];
  for (const stmt of named(root)) phpTopLevel(ctx, stmt, moduleExt, imports);

  return {
    symbols: ctx.symbols,
    defines: ctx.defines,
    imports,
    calls: ctx.calls,
    moduleExternalId: moduleExt,
  };
}

// ---- Rust ------------------------------------------------------------------

// Rust doc-comments are `///`/`//!` (each line its own `line_comment`) or `/** */`
// (`block_comment`); attributes (`#[…]`) sit between the doc and the item. Walk back
// past attributes, then to the top of the consecutive comment run, and use its first line.
function docForRust(node: Node): string | null {
  let prev = node.previousSibling;
  while (prev?.type === "attribute_item") prev = prev.previousSibling;
  let first: Node | null = null;
  while (prev && (prev.type === "line_comment" || prev.type === "block_comment")) {
    first = prev;
    prev = prev.previousSibling;
  }
  return first ? docFromComment(first) : null;
}

// The base identifier of a (possibly generic/referenced) type: `Wrap<T>` -> `Wrap`.
function rustTypeName(node: Node): string {
  if (node.type === "type_identifier") return node.text;
  const id = node.descendantsOfType("type_identifier").find((n): n is Node => n != null);
  return id ? id.text : oneLine(node.text);
}

function calleeRust(fn: Node): string | null {
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "field_expression") return fn.childForFieldName("field")?.text ?? null;
  if (fn.type === "scoped_identifier")
    return fn.childForFieldName("name")?.text ?? fn.namedChildren.at(-1)?.text ?? null;
  return null;
}

function collectCallsRust(ctx: Ctx, srcQualified: string, body: Node | null): void {
  if (!body) return;
  for (const call of body.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const callee = calleeRust(fn);
    if (callee) ctx.calls.push({ srcQualified, callee });
  }
}

// The binding name(s) a `use` argument introduces. Paths aren't resolved to files
// (that needs the crate module tree), so resolution is by-name repo-wide, like PHP.
function useBindings(arg: Node | null): string[] {
  if (!arg) return [];
  switch (arg.type) {
    case "identifier":
    case "type_identifier":
      return [arg.text];
    case "scoped_identifier":
      return arg.childForFieldName("name")?.text ? [arg.childForFieldName("name")!.text] : [];
    case "use_as_clause":
      return arg.childForFieldName("alias")?.text ? [arg.childForFieldName("alias")!.text] : [];
    case "scoped_use_list":
    case "use_list": {
      const list = arg.type === "use_list" ? arg : named(arg).find((c) => c.type === "use_list");
      return list ? named(list).flatMap((item) => useBindings(item)) : [];
    }
    default:
      return []; // use_wildcard (`::*`), `self`, etc. -> no single binding
  }
}

function handleRustUse(node: Node): ImportRef[] {
  return useBindings(node.childForFieldName("argument")).map((name) => ({
    name,
    candidatePaths: [],
    namespace: false,
    byName: true,
  }));
}

// Methods of a trait/impl body. Trait method signatures (`fn f();`) have no body node.
function handleRustMethods(ctx: Ctx, body: Node | null, ownerExt: string, ownerQual: string): void {
  if (!body) return;
  for (const member of named(body)) {
    if (member.type !== "function_item" && member.type !== "function_signature_item") continue;
    const mName = nameOf(member);
    if (!mName) continue;
    const mQual = `${ownerQual}.${mName}`;
    const mBody = member.childForFieldName("body");
    const mExt = push(ctx, "method", mName, mQual, member, mBody, docForRust(member));
    ctx.defines.push({ src: ownerExt, dst: mExt });
    collectCallsRust(ctx, mQual, mBody);
  }
}

function handleRustImpl(ctx: Ctx, node: Node, moduleExt: string, prefix: string): void {
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return;
  const typeName = rustTypeName(typeNode);
  const traitNode = node.childForFieldName("trait");
  const body = node.childForFieldName("body");
  // The impl symbol is named after its type (so a lookup of the type surfaces it); the
  // qualified name distinguishes an inherent impl from each `impl Trait for Type`.
  const label = traitNode ? `impl ${rustTypeName(traitNode)} for ${typeName}` : `impl ${typeName}`;
  const ext = push(
    ctx,
    "impl",
    typeName,
    `${ctx.path}:${prefix}${label}`,
    node,
    body,
    docForRust(node),
  );
  ctx.defines.push({ src: moduleExt, dst: ext });
  handleRustMethods(ctx, body, ext, `${ctx.path}:${prefix}${typeName}`);
}

function handleRustItem(ctx: Ctx, node: Node, containerExt: string, prefix: string): void {
  const doc = docForRust(node);
  const qual = (name: string): string => `${ctx.path}:${prefix}${name}`;
  const simple = (kind: string, body: Node | null): void => {
    const name = nameOf(node);
    if (!name) return;
    const ext = push(ctx, kind, name, qual(name), node, body, doc);
    ctx.defines.push({ src: containerExt, dst: ext });
  };
  switch (node.type) {
    case "function_item": {
      const name = nameOf(node);
      if (!name) return;
      const body = node.childForFieldName("body");
      const ext = push(ctx, "function", name, qual(name), node, body, doc);
      ctx.defines.push({ src: containerExt, dst: ext });
      collectCallsRust(ctx, qual(name), body);
      return;
    }
    case "struct_item":
    case "union_item":
      simple("struct", node.childForFieldName("body"));
      return;
    case "enum_item":
      simple("enum", node.childForFieldName("body"));
      return;
    case "trait_item": {
      const name = nameOf(node);
      if (!name) return;
      const body = node.childForFieldName("body");
      const ext = push(ctx, "trait", name, qual(name), node, body, doc);
      ctx.defines.push({ src: containerExt, dst: ext });
      handleRustMethods(ctx, body, ext, qual(name));
      return;
    }
    case "impl_item":
      handleRustImpl(ctx, node, containerExt, prefix);
      return;
    case "const_item":
    case "static_item":
      simple("const", null);
      return;
    case "type_item":
      simple("type", null);
      return;
    case "macro_definition":
      simple("macro", null);
      return;
    case "mod_item": {
      const name = nameOf(node);
      if (!name) return;
      const body = named(node).find((c) => c.type === "declaration_list") ?? null;
      if (!body) return; // `mod foo;` points to another file — nothing to extract here
      const ext = push(ctx, "mod", name, qual(name), node, body, doc);
      ctx.defines.push({ src: containerExt, dst: ext });
      for (const item of named(body)) handleRustItem(ctx, item, ext, `${prefix}${name}::`);
      return;
    }
  }
}

function extractRust(repo: string, path: string, source: string, root: Node): FileExtract {
  const moduleExt = stableSymbolId(repo, path, path, "module");
  const ctx: Ctx = { repo, path, symbols: [], defines: [], calls: [], seenExt: new Set() };
  const first = root.namedChild(0);
  const fileDoc =
    first?.type === "line_comment" || first?.type === "block_comment"
      ? docFromComment(first)
      : null;
  const moduleSig = `module ${path}`;
  ctx.symbols.push({
    external_id: moduleExt,
    symbol_kind: "module",
    name: posix.basename(path),
    qualified: path,
    signature: moduleSig,
    summary: summaryOf(moduleSig, fileDoc),
    start_line: 1,
    end_line: root.endPosition.row + 1,
    code_hash: sha24(source),
    source,
  });
  ctx.seenExt.add(moduleExt);

  const imports: ImportRef[] = [];
  for (const stmt of named(root)) {
    if (stmt.type === "use_declaration") imports.push(...handleRustUse(stmt));
    else handleRustItem(ctx, stmt, moduleExt, "");
  }

  return {
    symbols: ctx.symbols,
    defines: ctx.defines,
    imports,
    calls: ctx.calls,
    moduleExternalId: moduleExt,
  };
}
