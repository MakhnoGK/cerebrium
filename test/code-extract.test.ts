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

describe("TypeScript extraction", () => {
  it("should extract module, class, method, interface, and const symbols with correct kinds and qualified names when parsing a TS service", async () => {
    // Given / When
    const ex = await extract("auth/auth.service.ts");

    // Then
    const byQual = new Map(ex.symbols.map((s) => [s.qualified, s]));
    expect(byQual.get("auth/auth.service.ts")?.symbol_kind).toBe("module");
    expect(byQual.get("auth/auth.service.ts:AuthService")?.symbol_kind).toBe("class");
    expect(byQual.get("auth/auth.service.ts:AuthService.validate")?.symbol_kind).toBe("method");
    expect(byQual.get("auth/auth.service.ts:AuthService.issue")?.symbol_kind).toBe("method");
    expect(byQual.get("auth/auth.service.ts:Credentials")?.symbol_kind).toBe("interface");
    expect(byQual.get("auth/auth.service.ts:TOKEN_TTL")?.symbol_kind).toBe("const");
  });

  it("should capture the signature and leading doc-comment in the summary when extracting a TS class and method", async () => {
    // Given / When
    const ex = await extract("auth/auth.service.ts");

    // Then
    const cls = ex.symbols.find((s) => s.qualified === "auth/auth.service.ts:AuthService")!;
    expect(cls.signature).toContain("class AuthService");
    expect(cls.signature).not.toContain("{");
    expect(cls.summary).toContain("Auth business logic"); // doc-comment before the decorated export
    const validate = ex.symbols.find((s) => s.qualified.endsWith("AuthService.validate"))!;
    expect(validate.summary).toContain("Validate a set of login credentials");
  });

  it("should emit defines edges from module to members and class to methods when extracting a TS service", async () => {
    // Given / When
    const ex = await extract("auth/auth.service.ts");

    // Then
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth/auth.service.ts"), id("auth/auth.service.ts:AuthService"))).toBe(true);
    expect(has(id("auth/auth.service.ts"), id("auth/auth.service.ts:TOKEN_TTL"))).toBe(true);
    expect(
      has(id("auth/auth.service.ts:AuthService"), id("auth/auth.service.ts:AuthService.validate")),
    ).toBe(true);
  });

  it("should resolve relative import candidates and drop bare specifiers when extracting TS imports", async () => {
    // Given / When
    const ex = await extract("auth/auth.service.ts");

    // Then
    // '@nestjs/common' is bare -> no import ref at all.
    expect(ex.imports.some((i) => i.name === "Injectable")).toBe(false);
    // '../util/crypto' -> repo-relative candidates including util/crypto.ts.
    const hashImport = ex.imports.find((i) => i.name === "hashToken");
    expect(hashImport).toBeDefined();
    expect(hashImport!.candidatePaths).toContain("util/crypto.ts");
  });

  it("should capture best-effort calls for identifier and this.method references when extracting a TS service", async () => {
    // Given / When
    const ex = await extract("auth/auth.service.ts");

    // Then
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

  it("should extract function, enum, and type kinds when extracting a plain TS module", async () => {
    // Given / When
    const ex = await extract("util/crypto.ts");

    // Then
    const kinds = new Map(ex.symbols.map((s) => [s.name, s.symbol_kind]));
    expect(kinds.get("hashToken")).toBe("function");
    expect(kinds.get("Algo")).toBe("enum");
    expect(kinds.get("Hash")).toBe("type");
  });
});

describe("PHP extraction", () => {
  it("should extract class, method, function, interface, trait, enum, and const symbols with correct kinds when parsing a PHP file", async () => {
    // Given / When
    const ex = await extract("AuthService.php", "fixtures/php-repo");

    // Then
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

  it("should capture signatures, docblocks, defines edges, use-imports, and calls when parsing a PHP file", async () => {
    // Given / When
    const ex = await extract("AuthService.php", "fixtures/php-repo");

    // Then
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
  it("should extract module, struct, enum, trait, impl, method, function, const, and type symbols with correct kinds and qualified names when parsing a Rust file", async () => {
    // Given / When
    const ex = await extract("auth.rs", "fixtures/rust-repo");

    // Then
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

  it("should capture the signature and leading doc-comment past attributes when extracting a Rust struct and method", async () => {
    // Given / When
    const ex = await extract("auth.rs", "fixtures/rust-repo");

    // Then
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

  it("should emit defines edges from module to items, impl to methods, and trait to methods when extracting a Rust file", async () => {
    // Given / When
    const ex = await extract("auth.rs", "fixtures/rust-repo");

    // Then
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth.rs"), id("auth.rs:AuthService"))).toBe(true);
    expect(has(id("auth.rs"), id("auth.rs:impl AuthService"))).toBe(true);
    expect(has(id("auth.rs:impl AuthService"), id("auth.rs:AuthService.issue"))).toBe(true);
    expect(has(id("auth.rs:Validator"), id("auth.rs:Validator.validate"))).toBe(true);
  });

  it("should resolve use bindings by name with no candidate paths when extracting Rust imports", async () => {
    // Given / When
    const ex = await extract("auth.rs", "fixtures/rust-repo");

    // Then
    const hashImport = ex.imports.find((i) => i.name === "hash_token");
    expect(hashImport).toMatchObject({ byName: true, candidatePaths: [] });
    expect(ex.imports.some((i) => i.name === "Algo")).toBe(true); // from the `{…}` use-list
    expect(ex.imports.some((i) => i.name === "HashMap")).toBe(true);
  });

  it("should capture best-effort calls for identifier, self.method, and scoped references when extracting a Rust file", async () => {
    // Given / When
    const ex = await extract("auth.rs", "fixtures/rust-repo");

    // Then
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
