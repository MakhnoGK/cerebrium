import { describe, expect, it } from "vitest";
import {
  formatAnswer,
  globIsIndexed,
  parseSearch,
  repoFor,
  reposOf,
  resolvePath,
  scopeOf,
  symbolOf,
  type Search,
} from "@plugin/install/claude-mod/hooks/code-nav.ts";

const REPO = "/work/acme";

function search(over: Partial<Search>): Search {
  return { pattern: "AuthService", cwd: REPO, paths: [], globs: [], types: [], ...over };
}

describe("symbolOf", () => {
  it("resolves code-shaped patterns to a symbol", () => {
    expect(symbolOf("AuthService")).toBe("AuthService");
    expect(symbolOf("\\bAuthService\\b")).toBe("AuthService");
    expect(symbolOf("class AuthService")).toBe("AuthService");
    expect(symbolOf("function\\s+indexOnHost")).toBe("indexOnHost");
    expect(symbolOf("loadConfig\\(")).toBe("loadConfig");
    expect(symbolOf("session_start")).toBe("session_start");
    expect(symbolOf("AuthService\\.validate")).toBe("AuthService.validate");
    expect(symbolOf("fn parse")).toBe("parse");
  });

  it("leaves text patterns alone", () => {
    expect(symbolOf("config")).toBeUndefined();
    expect(symbolOf("id")).toBeUndefined();
    expect(symbolOf("fetch failed")).toBeUndefined();
    expect(symbolOf("TODO.*fix")).toBeUndefined();
    expect(symbolOf("import .* from")).toBeUndefined();
  });
});

describe("paths and globs", () => {
  it("matches indexed extensions and repo roots", () => {
    expect(globIsIndexed("*.{ts,tsx}")).toBe(true);
    expect(globIsIndexed("**/*.md")).toBe(false);
    expect(globIsIndexed("src/**")).toBe(true);
    expect(resolvePath(REPO, "src/../lib")).toBe(`${REPO}/lib`);
    expect(resolvePath(`${REPO}/`, undefined)).toBe(REPO);
    expect(repoFor([REPO, `${REPO}/sub`], `${REPO}/sub/x.ts`)).toBe(`${REPO}/sub`);
    expect(repoFor([REPO], "/work/acme-two")).toBeUndefined();
    expect(reposOf(JSON.stringify({ repos: [`${REPO}/`, 7] }))).toEqual([REPO]);
  });
});

describe("parseSearch", () => {
  it("reads rg, grep -r and git grep", () => {
    expect(parseSearch("rg -n AuthService src", REPO)).toEqual(search({ paths: ["src"] }));
    expect(parseSearch("rg -n 'class AuthService' -g '*.ts' 2>/dev/null | head", REPO)).toEqual(
      search({ pattern: "class AuthService", globs: ["*.ts"] }),
    );
    expect(parseSearch("cd apps && grep -rn --include=*.md loadConfig .", REPO)).toEqual(
      search({ pattern: "loadConfig", cwd: `${REPO}/apps`, paths: ["."], globs: ["*.md"] }),
    );
    expect(parseSearch("rg -t py -e parse_args", REPO)).toEqual(
      search({ pattern: "parse_args", types: ["py"] }),
    );
    expect(parseSearch("git grep -n AuthService", REPO)?.pattern).toBe("AuthService");
  });

  it("ignores what is not a recursive code search", () => {
    expect(parseSearch("grep AuthService file.ts", REPO)).toBeUndefined();
    expect(parseSearch("git log | grep fix", REPO)).toBeUndefined();
    expect(parseSearch("find . -name '*.ts'", REPO)).toBeUndefined();
    expect(parseSearch('rg "$NAME" src', REPO)).toBeUndefined();
    expect(parseSearch("rg -f patterns.txt", REPO)).toBeUndefined();
  });
});

describe("scopeOf", () => {
  const repos = [REPO];

  it("scopes a symbol search inside an indexed repo", () => {
    expect(scopeOf(search({}), repos)).toEqual({ symbol: "AuthService", repo: "acme" });
    expect(scopeOf(search({ paths: ["src/auth.ts"], globs: ["*.ts"] }), repos)?.repo).toBe("acme");
  });

  it("leaves text, other languages, docs and other directories to the shell", () => {
    expect(scopeOf(search({ pattern: "fetch failed" }), repos)).toBeUndefined();
    expect(scopeOf(search({ types: ["py"] }), repos)).toBeUndefined();
    expect(scopeOf(search({ globs: ["*.md"] }), repos)).toBeUndefined();
    expect(scopeOf(search({ paths: ["README.md"] }), repos)).toBeUndefined();
    expect(scopeOf(search({ cwd: "/tmp" }), repos)).toBeUndefined();
    expect(scopeOf(search({ paths: ["src", "/elsewhere"] }), repos)).toBeUndefined();
  });
});

describe("formatAnswer", () => {
  it("lists each symbol with its location, id and callers", () => {
    const text = formatAnswer(
      "AuthService",
      "acme",
      [
        {
          id: "4NM4R63SMDA93EG7X1BKAJZ0EC",
          title: "src/auth.ts:AuthService",
          signature: "class AuthService",
          path: "src/auth.ts",
          start_line: 10,
          end_line: 80,
          branch: "dev",
          neighbors: [{ title: "src/app.ts:boot", edge: "calls", direction: "in" }],
        },
      ],
      "run the identical command again",
    );
    expect(text).toContain("repo acme, branch dev");
    expect(text).toContain(
      "- class AuthService — src/auth.ts:10-80 (id 4NM4R63SMDA93EG7X1BKAJZ0EC)",
    );
    expect(text).toContain("called by: src/app.ts:boot");
    expect(text).toContain("run the identical command again and it will go through");
  });
});
