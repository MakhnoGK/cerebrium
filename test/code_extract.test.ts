import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "@/code/parser";
import { extractFile } from "@/code/extract";
import { langForPath } from "@/code/languages";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "demo";

async function extract(relPath: string, base = "fixtures/demo-repo") {
  const abs = join(here, base, relPath);
  const source = readFileSync(abs, "utf8");
  const lang = langForPath(relPath)!;
  const tree = await parse(lang.wasm, source);
  return extractFile(REPO, relPath, lang.lang, source, tree.rootNode);
}

describe("TS extraction", () => {
  it("extracts module, class, methods, interface, const with kinds & qualified names", async () => {
    const ex = await extract("auth/auth.service.ts");
    const byQual = new Map(ex.symbols.map((s) => [s.qualified, s]));

    expect(byQual.get("auth/auth.service.ts")?.symbol_kind).toBe("module");
    expect(byQual.get("auth/auth.service.ts:AuthService")?.symbol_kind).toBe("class");
    expect(byQual.get("auth/auth.service.ts:AuthService.validate")?.symbol_kind).toBe("method");
    expect(byQual.get("auth/auth.service.ts:AuthService.issue")?.symbol_kind).toBe("method");
    expect(byQual.get("auth/auth.service.ts:Credentials")?.symbol_kind).toBe("interface");
    expect(byQual.get("auth/auth.service.ts:TOKEN_TTL")?.symbol_kind).toBe("const");
  });

  it("captures signature and leading doc-comment in the summary (deterministic)", async () => {
    const ex = await extract("auth/auth.service.ts");
    const cls = ex.symbols.find((s) => s.qualified === "auth/auth.service.ts:AuthService")!;
    expect(cls.signature).toContain("class AuthService");
    expect(cls.signature).not.toContain("{");
    expect(cls.summary).toContain("Auth business logic"); // doc-comment before the decorated export
    const validate = ex.symbols.find((s) => s.qualified.endsWith("AuthService.validate"))!;
    expect(validate.summary).toContain("Validate a set of login credentials");
  });

  it("emits defines edges: module->members and class->methods", async () => {
    const ex = await extract("auth/auth.service.ts");
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth/auth.service.ts"), id("auth/auth.service.ts:AuthService"))).toBe(true);
    expect(has(id("auth/auth.service.ts"), id("auth/auth.service.ts:TOKEN_TTL"))).toBe(true);
    expect(
      has(id("auth/auth.service.ts:AuthService"), id("auth/auth.service.ts:AuthService.validate")),
    ).toBe(true);
  });

  it("resolves relative import candidates and drops bare specifiers", async () => {
    const ex = await extract("auth/auth.service.ts");
    // '@nestjs/common' is bare -> no import ref at all.
    expect(ex.imports.some((i) => i.name === "Injectable")).toBe(false);
    // '../util/crypto' -> repo-relative candidates including util/crypto.ts.
    const hashImport = ex.imports.find((i) => i.name === "hashToken");
    expect(hashImport).toBeDefined();
    expect(hashImport!.candidatePaths).toContain("util/crypto.ts");
  });

  it("captures best-effort calls (identifier and this.method)", async () => {
    const ex = await extract("auth/auth.service.ts");
    const calls = ex.calls;
    expect(calls).toContainEqual({
      srcQualified: "auth/auth.service.ts:AuthService.validate",
      callee: "hashToken",
    });
    expect(calls).toContainEqual({
      srcQualified: "auth/auth.service.ts:AuthService.issue",
      callee: "validate",
    });
  });

  it("extracts enum and type from a plain module", async () => {
    const ex = await extract("util/crypto.ts");
    const kinds = new Map(ex.symbols.map((s) => [s.name, s.symbol_kind]));
    expect(kinds.get("hashToken")).toBe("function");
    expect(kinds.get("Algo")).toBe("enum");
    expect(kinds.get("Hash")).toBe("type");
  });
});

describe("PHP extraction", () => {
  it("extracts class/method/function/interface/trait/enum/const with kinds", async () => {
    const ex = await extract("AuthService.php", "fixtures/php-repo");
    const kinds = new Map(ex.symbols.map((s) => [s.name, s.symbol_kind]));
    expect(kinds.get("AuthService.php")).toBe("module");
    expect(kinds.get("AuthService")).toBe("class");
    expect(kinds.get("validate")).toBe("method");
    expect(kinds.get("bootstrap")).toBe("function");
    expect(kinds.get("Validator")).toBe("interface");
    expect(kinds.get("Loggable")).toBe("trait");
    expect(kinds.get("Algo")).toBe("enum");
    expect(kinds.get("TOKEN_TTL")).toBe("const");
  });

  it("captures signature + docblock, defines edges, use-imports, and calls", async () => {
    const ex = await extract("AuthService.php", "fixtures/php-repo");
    const cls = ex.symbols.find((s) => s.name === "AuthService")!;
    expect(cls.signature).toContain("class AuthService");
    expect(cls.signature).not.toContain("{");
    const validate = ex.symbols.find((s) => s.qualified.endsWith("AuthService.validate"))!;
    expect(validate.summary).toContain("Validate a set of login credentials");

    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);
    expect(has(id("AuthService.php"), id("AuthService.php:AuthService"))).toBe(true);
    expect(has(id("AuthService.php:AuthService"), id("AuthService.php:AuthService.validate"))).toBe(
      true,
    );

    // `use App\Util\Hasher;` -> by-name import ref for 'Hasher'
    const hasherImport = ex.imports.find((i) => i.name === "Hasher");
    expect(hasherImport).toMatchObject({ byName: true });

    // Hasher::hash() and $this->validate() captured as calls
    expect(ex.calls).toContainEqual({
      srcQualified: "AuthService.php:AuthService.validate",
      callee: "hash",
    });
    expect(ex.calls).toContainEqual({
      srcQualified: "AuthService.php:AuthService.issue",
      callee: "validate",
    });
  });
});

describe("Rust extraction", () => {
  it("extracts module/struct/enum/trait/impl/method/function/const/type with kinds & qualified names", async () => {
    const ex = await extract("auth.rs", "fixtures/rust-repo");
    const byQual = new Map(ex.symbols.map((s) => [s.qualified, s]));

    expect(byQual.get("auth.rs")?.symbol_kind).toBe("module");
    expect(byQual.get("auth.rs:AuthService")?.symbol_kind).toBe("struct");
    expect(byQual.get("auth.rs:Algo")?.symbol_kind).toBe("enum");
    expect(byQual.get("auth.rs:Validator")?.symbol_kind).toBe("trait");
    expect(byQual.get("auth.rs:TOKEN_TTL")?.symbol_kind).toBe("const");
    expect(byQual.get("auth.rs:Token")?.symbol_kind).toBe("type");
    expect(byQual.get("auth.rs:bootstrap")?.symbol_kind).toBe("function");
    expect(byQual.get("auth.rs:AuthService.issue")?.symbol_kind).toBe("method");
    expect(byQual.get("auth.rs:AuthService.validate")?.symbol_kind).toBe("method");

    // Inherent and trait impls are distinct `impl` symbols, both named after the type.
    expect(byQual.get("auth.rs:impl AuthService")?.symbol_kind).toBe("impl");
    expect(byQual.get("auth.rs:impl AuthService")?.name).toBe("AuthService");
    expect(byQual.get("auth.rs:impl Validator for AuthService")?.symbol_kind).toBe("impl");
  });

  it("captures signature and leading doc-comment past attributes (deterministic)", async () => {
    const ex = await extract("auth.rs", "fixtures/rust-repo");
    const s = ex.symbols.find((x) => x.qualified === "auth.rs:AuthService")!;
    expect(s.signature).toContain("struct AuthService");
    expect(s.signature).not.toContain("{");
    expect(s.summary).toContain("Auth business logic"); // doc precedes the #[derive] attribute
    const validate = ex.symbols.find((x) => x.qualified === "auth.rs:AuthService.validate")!;
    expect(ex.symbols.find((x) => x.qualified === "auth.rs:Validator.validate")!.summary).toContain(
      "Validate a set of login credentials",
    );
    expect(validate.signature).toContain("fn validate");
  });

  it("emits defines edges: module->items, impl->methods, trait->methods", async () => {
    const ex = await extract("auth.rs", "fixtures/rust-repo");
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth.rs"), id("auth.rs:AuthService"))).toBe(true);
    expect(has(id("auth.rs"), id("auth.rs:impl AuthService"))).toBe(true);
    expect(has(id("auth.rs:impl AuthService"), id("auth.rs:AuthService.issue"))).toBe(true);
    expect(has(id("auth.rs:Validator"), id("auth.rs:Validator.validate"))).toBe(true);
  });

  it("resolves `use` bindings by name (path + list + no candidate paths)", async () => {
    const ex = await extract("auth.rs", "fixtures/rust-repo");
    const hashImport = ex.imports.find((i) => i.name === "hash_token");
    expect(hashImport).toMatchObject({ byName: true, candidatePaths: [] });
    expect(ex.imports.some((i) => i.name === "Algo")).toBe(true); // from the `{…}` use-list
    expect(ex.imports.some((i) => i.name === "HashMap")).toBe(true);
  });

  it("captures best-effort calls (identifier, self.method, scoped)", async () => {
    const ex = await extract("auth.rs", "fixtures/rust-repo");
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.rs:AuthService.issue",
      callee: "validate",
    });
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.rs:AuthService.issue",
      callee: "hash_token",
    });
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.rs:AuthService.validate",
      callee: "hash_token",
    });
  });
});
