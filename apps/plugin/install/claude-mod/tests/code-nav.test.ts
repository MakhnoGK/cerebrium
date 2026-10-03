import { describe, expect, test } from "claude-code/testing";

const REPO = "/work/acme";
const CONFIG = JSON.stringify({ repos: [REPO, "/work/other"] });
const SYMBOL = {
  id: "4NM4R63SMDA93EG7X1BKAJZ0EC",
  title: "src/auth.ts:AuthService",
  signature: "class AuthService",
  path: "src/auth.ts",
  start_line: 10,
  end_line: 80,
  branch: "dev",
  neighbors: [{ title: "src/app.ts:boot", edge: "calls", direction: "in" }],
};

function mcpText(value: unknown) {
  return { value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } };
}

describe("Grep in an indexed repo", () => {
  test("a symbol Grep is answered from code_lookup, and repeating it runs Grep", async ($, on) => {
    const calls: string[] = [];
    on("session.cwd", () => ({ value: REPO }));
    on("env.get", () => ({ value: "/home/me" }));
    on("fs.read", () => ({ value: CONFIG }));
    on("mcp.call", (_, e) => {
      calls.push(`${e.tool}:${JSON.stringify(e.args)}`);
      return e.tool === "session_start"
        ? mcpText({ session_id: "01M41K7QS754H8GD4MMXA9T747" })
        : mcpText({ symbols: [SYMBOL] });
    });
    on("tool.call", () => ({ result: "grep ran" }));

    const first = await $.tool.call({
      tool: "Grep",
      tool_use_id: "t1",
      pattern: "AuthService",
    } as never);
    expect(first.deny).toContain("src/auth.ts:10-80");
    expect(first.deny).toContain("called by: src/app.ts:boot");
    expect(calls[1]).toContain('"repo":"acme"');

    const second = await $.tool.call({
      tool: "Grep",
      tool_use_id: "t2",
      pattern: "AuthService",
    } as never);
    expect(second.result).toBe("grep ran");
  });

  test("no symbols, a text pattern, a markdown glob or another directory all run Grep", async ($, on) => {
    on("session.cwd", () => ({ value: REPO }));
    on("env.get", () => ({ value: "/home/me" }));
    on("fs.read", () => ({ value: CONFIG }));
    on("mcp.call", (_, e) =>
      e.tool === "session_start"
        ? mcpText({ session_id: "01M41K7QS754H8GD4MMXA9T747" })
        : mcpText({ symbols: [] }),
    );
    on("tool.call", () => ({ result: "grep ran" }));

    for (const input of [
      { pattern: "MissingThing" },
      { pattern: "fetch failed" },
      { pattern: "AuthService", glob: "*.md" },
      { pattern: "AuthService", path: "/elsewhere" },
      { pattern: "AuthService", path: "docs/README.md" },
    ]) {
      const r = await $.tool.call({ tool: "Grep", tool_use_id: "t", ...input } as never);
      expect(r.result).toBe("grep ran");
    }
  });

  test("Cerebrium down means Grep runs", async ($, on) => {
    on("session.cwd", () => ({ value: REPO }));
    on("env.get", () => ({ value: "/home/me" }));
    on("fs.read", () => ({ value: CONFIG }));
    on("mcp.call", () => ({ deny: "not connected" }));
    on("tool.call", () => ({ result: "grep ran" }));

    const r = await $.tool.call({
      tool: "Grep",
      tool_use_id: "t",
      pattern: "AuthService",
    } as never);
    expect(r.result).toBe("grep ran");
  });
});

describe("shell search in an indexed repo", () => {
  test("rg for a symbol is answered from the index once, then runs; text searches run", async ($, on) => {
    on("session.cwd", () => ({ value: `${REPO}/src` }));
    on("env.get", () => ({ value: "/home/me" }));
    on("fs.read", () => ({ value: CONFIG }));
    on("mcp.call", (_, e) =>
      e.tool === "session_start"
        ? mcpText({ session_id: "01M41K7QS754H8GD4MMXA9T747" })
        : mcpText({ symbols: [SYMBOL] }),
    );
    on("tool.call", () => ({ result: "bash ran" }));

    const first = await $.tool.call({
      tool: "Bash",
      tool_use_id: "b1",
      command: "rg -n AuthService",
    });
    expect(first.deny).toContain("src/auth.ts:10-80");
    expect(first.deny).toContain("run the identical command again");
    const again = await $.tool.call({
      tool: "Bash",
      tool_use_id: "b2",
      command: "rg -n AuthService",
    });
    expect(again.result).toBe("bash ran");
    const text = await $.tool.call({
      tool: "Bash",
      tool_use_id: "b3",
      command: "rg -n 'fetch failed'",
    });
    expect(text.result).toBe("bash ran");
    const docs = await $.tool.call({
      tool: "Bash",
      tool_use_id: "b4",
      command: 'rg -n AuthService -g "*.md"',
    });
    expect(docs.result).toBe("bash ran");
  });

  test("outside indexed repos nothing changes", async ($, on) => {
    on("session.cwd", () => ({ value: "/tmp/scratch" }));
    on("env.get", () => ({ value: "/home/me" }));
    on("fs.read", () => ({ value: CONFIG }));
    on("tool.call", () => ({ result: "bash ran" }));

    const r = await $.tool.call({ tool: "Bash", tool_use_id: "b", command: "rg -n AuthService" });
    expect(r.result).toBe("bash ran");
  });
});
