import { describe, expect, it } from "vitest";
import {
  codeSymbolId,
  isIndexablePath,
  normalizeRemote,
  ulidShaped,
} from "@cerebrium/contracts/code";
import { parseRequest } from "@cerebrium/contracts/rpc";

describe("A repo's identity across machines", () => {
  it.each([
    ["git@github.com:MakhnoGK/cerebrium.git", "github.com/makhnogk/cerebrium"],
    ["https://github.com/toonspace/toonspace-advers.git", "github.com/toonspace/toonspace-advers"],
    ["https://user@github.com/Acme/Widgets/", "github.com/acme/widgets"],
    ["ssh://git@gitlab.example.com:2222/group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
  ])("should read %s as %s", (url, key) => {
    // Given / When / Then
    expect(normalizeRemote(url)).toBe(key);
  });

  it("should resolve an SSH alias to the host it stands for", () => {
    // Given
    const url = "git@github-toonspace:toonspace/toonspace-builder.git";

    // When
    const key = normalizeRemote(url, (host) => (host === "github-toonspace" ? "github.com" : host));

    // Then
    expect(key).toBe("github.com/toonspace/toonspace-builder");
  });

  it("should refuse a string that names no repo", () => {
    // Given / When / Then
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("not a remote")).toBeNull();
  });
});

describe("Symbol ids of the per-branch index", () => {
  it("should be stable and pass the tools' node-id pattern", () => {
    // Given / When
    const id = codeSymbolId("unit", "src/a.ts:foo", "function");

    // Then
    expect(id).toBe(codeSymbolId("unit", "src/a.ts:foo", "function"));
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(ulidShaped("x")).not.toBe(ulidShaped("y"));
  });
});

describe("What the plugin uploads", () => {
  it.each([
    ["src/a.ts", true],
    ["node_modules/x/index.js", false],
    ["packages/k/dist/server.js", false],
    ["app/_ide_helper.php", false],
    ["README.md", false],
  ])("should treat %s as indexable: %s", (path, expected) => {
    // Given / When / Then
    expect(isIndexablePath(path)).toBe(expected);
  });
});

describe("The code context in a request's meta", () => {
  it("should carry a well-formed context and drop a malformed one", () => {
    // Given
    const frame = (code: unknown) =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "lookup_code", meta: { client: "c", code } });

    // When
    const good = parseRequest(frame({ remote_key: "github.com/a/b", branch: "main", extra: 1 }));
    const bad = parseRequest(frame({ remote_key: 7, branch: "main" }));

    // Then
    expect(good.ok && good.request.meta?.code).toEqual({
      remote_key: "github.com/a/b",
      branch: "main",
    });
    expect(bad.ok && bad.request.meta?.code).toBeUndefined();
  });
});
