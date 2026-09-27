import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFile } from "@/code/extract";
import { langForPath } from "@/code/languages";
import { parse } from "@/code/parser";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "demo";

async function extract(relPath: string, base = "fixtures/demo-repo") {
  const abs = join(here, base, relPath);
  const source = readFileSync(abs, "utf8");
  const lang = langForPath(relPath)!;
  const tree = await parse(lang.wasm, source, lang.vendored);
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

describe("C extraction", () => {
  it("should extract module, macro, typedef, enum, struct, and function symbols with correct kinds and qualified names when parsing a C file", async () => {
    // Given / When
    const ex = await extract("auth.c", "fixtures/c-repo");

    // Then
    const byQual = new Map(ex.symbols.map((s) => [s.qualified, s]));

    expect(byQual.get("auth.c")?.symbol_kind).toBe("module");
    expect(byQual.get("auth.c:TOKEN_TTL")?.symbol_kind).toBe("macro");
    expect(byQual.get("auth.c:Token")?.symbol_kind).toBe("type");
    expect(byQual.get("auth.c:Algo")?.symbol_kind).toBe("enum");
    expect(byQual.get("auth.c:AuthService")?.symbol_kind).toBe("struct");
    expect(byQual.get("auth.c:auth_validate")?.symbol_kind).toBe("function");
    expect(byQual.get("auth.c:auth_issue")?.symbol_kind).toBe("function");
  });

  it("should capture the signature up to the body and the leading block comment when extracting a C struct and function", async () => {
    // Given / When
    const ex = await extract("auth.c", "fixtures/c-repo");

    // Then
    const s = ex.symbols.find((x) => x.qualified === "auth.c:AuthService")!;
    expect(s.signature).toBe("struct AuthService");
    expect(s.summary).toContain("Auth business logic");
    const fn = ex.symbols.find((x) => x.qualified === "auth.c:auth_validate")!;
    expect(fn.signature).toBe("int auth_validate(struct AuthService *svc, const char *pw)");
    expect(fn.summary).toContain("Validate a set of login credentials");
  });

  it("should emit defines edges from the module to every top-level item when extracting a C file", async () => {
    // Given / When
    const ex = await extract("auth.c", "fixtures/c-repo");

    // Then
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth.c"), id("auth.c:AuthService"))).toBe(true);
    expect(has(id("auth.c"), id("auth.c:auth_issue"))).toBe(true);
    expect(has(id("auth.c"), id("auth.c:TOKEN_TTL"))).toBe(true);
  });

  it("should resolve quoted includes to repo paths and drop system headers when extracting C imports", async () => {
    // Given / When
    const ex = await extract("auth.c", "fixtures/c-repo");

    // Then
    expect(ex.imports).toHaveLength(1); // <stdlib.h> carries no repo path
    expect(ex.imports[0]).toMatchObject({ name: "util/crypto.h", namespace: true });
    expect(ex.imports[0]!.candidatePaths).toContain("util/crypto.h");
  });

  it("should extract a bare prototype as a function so an included header can answer a call when parsing a C header", async () => {
    // Given / When
    const ex = await extract("util/crypto.h", "fixtures/c-repo");

    // Then
    const fn = ex.symbols.find((s) => s.qualified === "util/crypto.h:hash_token")!;
    expect(fn.symbol_kind).toBe("function");
    expect(fn.signature).toBe("char *hash_token(const char *input);");
  });

  it("should capture best-effort calls for identifier references when extracting a C file", async () => {
    // Given / When
    const ex = await extract("auth.c", "fixtures/c-repo");

    // Then
    expect(ex.calls).toContainEqual({ srcQualified: "auth.c:auth_issue", callee: "auth_validate" });
    expect(ex.calls).toContainEqual({ srcQualified: "auth.c:auth_issue", callee: "hash_token" });
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.c:auth_validate",
      callee: "hash_token",
    });
  });
});

describe("C++ extraction", () => {
  it("should extract namespace, class, struct, enum, alias, method, and function symbols with namespace-prefixed qualified names when parsing a C++ file", async () => {
    // Given / When
    const ex = await extract("auth.cpp", "fixtures/cpp-repo");

    // Then
    const byQual = new Map(ex.symbols.map((s) => [s.qualified, s]));

    expect(byQual.get("auth.cpp")?.symbol_kind).toBe("module");
    expect(byQual.get("auth.cpp:app")?.symbol_kind).toBe("namespace");
    expect(byQual.get("auth.cpp:app::TOKEN_TTL")?.symbol_kind).toBe("const");
    expect(byQual.get("auth.cpp:app::Algo")?.symbol_kind).toBe("enum");
    expect(byQual.get("auth.cpp:app::Token")?.symbol_kind).toBe("type");
    expect(byQual.get("auth.cpp:app::Validator")?.symbol_kind).toBe("class");
    expect(byQual.get("auth.cpp:app::AuthService")?.symbol_kind).toBe("class");
    expect(byQual.get("auth.cpp:app::Claim")?.symbol_kind).toBe("struct");
    expect(byQual.get("auth.cpp:app::bootstrap")?.symbol_kind).toBe("function");
    expect(byQual.get("auth.cpp:app::AuthService.validate")?.symbol_kind).toBe("method");
    expect(byQual.get("auth.cpp:app::AuthService.issue")?.symbol_kind).toBe("method");
  });

  it("should capture the signature including the base clause and the leading /// run when extracting a C++ class and method", async () => {
    // Given / When
    const ex = await extract("auth.cpp", "fixtures/cpp-repo");

    // Then
    const cls = ex.symbols.find((s) => s.qualified === "auth.cpp:app::AuthService")!;
    expect(cls.signature).toBe("class AuthService : public Validator");
    expect(cls.summary).toContain("Auth business logic");
    const m = ex.symbols.find((s) => s.qualified === "auth.cpp:app::AuthService.validate")!;
    expect(m.signature).toBe("bool validate(const std::string &pw) override");
    expect(m.summary).toContain("Validate a set of login credentials");
  });

  it("should emit defines edges from module to namespace, namespace to types, and class to methods when extracting a C++ file", async () => {
    // Given / When
    const ex = await extract("auth.cpp", "fixtures/cpp-repo");

    // Then
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth.cpp"), id("auth.cpp:app"))).toBe(true);
    expect(has(id("auth.cpp:app"), id("auth.cpp:app::AuthService"))).toBe(true);
    expect(has(id("auth.cpp:app::AuthService"), id("auth.cpp:app::AuthService.validate"))).toBe(
      true,
    );
  });

  it("should attribute an out-of-line Foo::bar definition to its class exactly once when extracting a C++ file", async () => {
    // Given / When
    const ex = await extract("auth.cpp", "fixtures/cpp-repo");

    // Then
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const edges = ex.defines.filter(
      (d) =>
        d.src === id("auth.cpp:app::AuthService") &&
        d.dst === id("auth.cpp:app::AuthService.issue"),
    );
    expect(edges).toHaveLength(1);
    // The body only reachable through the out-of-line definition still yields its calls.
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.cpp:app::AuthService.issue",
      callee: "hash_token",
    });
  });

  it("should capture best-effort calls for identifier, member, and qualified references when extracting a C++ file", async () => {
    // Given / When
    const ex = await extract("auth.cpp", "fixtures/cpp-repo");

    // Then
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.cpp:app::AuthService.validate",
      callee: "hash_token",
    });
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.cpp:app::AuthService.issue",
      callee: "validate",
    });
  });
});

describe("Lua extraction", () => {
  it("should extract module, local const, table method, colon method, and function symbols with correct kinds and qualified names when parsing a Lua file", async () => {
    // Given / When
    const ex = await extract("auth.lua", "fixtures/lua-repo");

    // Then
    const byQual = new Map(ex.symbols.map((s) => [s.qualified, s]));

    expect(byQual.get("auth.lua")?.symbol_kind).toBe("module");
    expect(byQual.get("auth.lua:TOKEN_TTL")?.symbol_kind).toBe("const");
    expect(byQual.get("auth.lua:AuthService")?.symbol_kind).toBe("const");
    expect(byQual.get("auth.lua:AuthService.validate")?.symbol_kind).toBe("method");
    expect(byQual.get("auth.lua:AuthService.issue")?.symbol_kind).toBe("method");
    expect(byQual.get("auth.lua:bootstrap")?.symbol_kind).toBe("function");
    expect(byQual.get("auth.lua:reset_counter")?.symbol_kind).toBe("function");
  });

  it("should capture the signature and the leading -- doc run when extracting a Lua binding and method", async () => {
    // Given / When
    const ex = await extract("auth.lua", "fixtures/lua-repo");

    // Then
    const ttl = ex.symbols.find((s) => s.qualified === "auth.lua:TOKEN_TTL")!;
    expect(ttl.signature).toBe("local TOKEN_TTL = 900");
    expect(ttl.summary).toContain("Token time-to-live, in seconds.");
    const m = ex.symbols.find((s) => s.qualified === "auth.lua:AuthService.issue")!;
    expect(m.signature).toBe("function AuthService:issue(pw)");
    expect(m.summary).toContain("Issue a token for valid credentials.");
  });

  it("should emit defines edges from the module to top-level bindings and from the table to its methods when extracting a Lua file", async () => {
    // Given / When
    const ex = await extract("auth.lua", "fixtures/lua-repo");

    // Then
    const id = (q: string) => ex.symbols.find((s) => s.qualified === q)!.external_id;
    const has = (src: string, dst: string) =>
      ex.defines.some((d) => d.src === src && d.dst === dst);

    expect(has(id("auth.lua"), id("auth.lua:AuthService"))).toBe(true);
    expect(has(id("auth.lua"), id("auth.lua:bootstrap"))).toBe(true);
    expect(has(id("auth.lua:AuthService"), id("auth.lua:AuthService.validate"))).toBe(true);
  });

  it("should resolve require specifiers to repo-root module paths and emit no symbol for the binding when extracting Lua imports", async () => {
    // Given / When
    const ex = await extract("auth.lua", "fixtures/lua-repo");

    // Then
    expect(ex.imports).toHaveLength(1);
    expect(ex.imports[0]).toMatchObject({ name: "util.crypto", namespace: true });
    expect(ex.imports[0]!.candidatePaths).toEqual(["util/crypto.lua", "util/crypto/init.lua"]);
    expect(ex.symbols.some((s) => s.name === "crypto")).toBe(false);
  });

  it("should capture best-effort calls for plain, dotted, and table-local references when extracting a Lua file", async () => {
    // Given / When
    const ex = await extract("auth.lua", "fixtures/lua-repo");

    // Then
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.lua:AuthService.validate",
      callee: "hash_token",
    });
    expect(ex.calls).toContainEqual({
      srcQualified: "auth.lua:AuthService.issue",
      callee: "validate",
    });
    expect(ex.calls).toContainEqual({ srcQualified: "auth.lua:bootstrap", callee: "setmetatable" });
  });
});
