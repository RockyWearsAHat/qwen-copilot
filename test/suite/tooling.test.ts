import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import { ToolSourceParser } from "../../src/tools/toolSourceParser";

suite("Tooling modules", () => {
  test("ToolSourceParser.getDiscoveryRoots includes workspace and absolute extra roots only", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const absoluteExtraRoot = path.resolve(
      os.tmpdir(),
      "local-qwen-extra-root",
    );
    const roots = (await parser.getDiscoveryRoots([
      "relative/path",
      absoluteExtraRoot,
      "",
    ])) as string[];

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot);
    assert.ok(roots.includes(workspaceRoot));
    assert.ok(roots.includes(absoluteExtraRoot));
    assert.equal(roots.includes("relative/path"), false);
  });

  test("ToolSourceParser.getDiscoveryRoots includes copilot chat extension path when available", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const copilotPath = path.resolve(os.tmpdir(), "copilot-chat-extension");
    const originalGetExtension = vscode.extensions.getExtension;

    Object.defineProperty(vscode.extensions, "getExtension", {
      configurable: true,
      value: (id: string) => {
        if (id === "GitHub.copilot-chat") {
          return { extensionPath: copilotPath };
        }
        return undefined;
      },
    });

    try {
      const roots = (await parser.getDiscoveryRoots([])) as string[];
      assert.ok(roots.includes(copilotPath));
    } finally {
      Object.defineProperty(vscode.extensions, "getExtension", {
        configurable: true,
        value: originalGetExtension,
      });
    }
  });

  test("ToolSourceParser.getDiscoveryRoots works when no workspace folders are open", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const extraRoot = path.resolve(os.tmpdir(), "local-qwen-root-only-extra");
    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;

    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: undefined,
    });

    try {
      const roots = (await parser.getDiscoveryRoots([extraRoot])) as string[];
      assert.deepEqual(roots, [extraRoot]);
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        value: originalWorkspaceFolders,
      });
    }
  });

  test("ToolSourceParser.walk respects budget and filters unsupported entries", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "local-qwen-walk-"),
    );
    const srcDir = path.join(tmpRoot, "src");
    const nodeModulesDir = path.join(tmpRoot, "node_modules");
    const gitDir = path.join(tmpRoot, ".git-hidden");

    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(nodeModulesDir, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });

    await fs.writeFile(
      path.join(srcDir, "a.ts"),
      "export const x = 1;",
      "utf8",
    );
    await fs.writeFile(
      path.join(srcDir, "b.js"),
      "module.exports = {};",
      "utf8",
    );
    await fs.writeFile(path.join(srcDir, "c.txt"), "ignore", "utf8");
    await fs.writeFile(
      path.join(nodeModulesDir, "skip.ts"),
      "export {};",
      "utf8",
    );
    await fs.writeFile(path.join(gitDir, "skip.js"), "export {};", "utf8");

    const symlinkPath = path.join(tmpRoot, "sym");
    await fs.symlink(path.join(srcDir, "a.ts"), symlinkPath);

    const zeroBudget = (await parser.walk(tmpRoot, 0)) as string[];
    assert.deepEqual(zeroBudget, []);

    const oneResult = (await parser.walk(tmpRoot, 1)) as string[];
    assert.equal(oneResult.length, 1);

    const all = (await parser.walk(tmpRoot, 20)) as string[];
    const normalized = all.map((item: string) => item.replace(/\\/g, "/"));

    assert.ok(normalized.some((file: string) => file.endsWith("/src/a.ts")));
    assert.ok(normalized.some((file: string) => file.endsWith("/src/b.js")));
    assert.equal(
      normalized.some((file: string) => file.includes("/node_modules/")),
      false,
    );
    assert.equal(
      normalized.some((file: string) => file.includes("/.git-hidden/")),
      false,
    );
    assert.equal(
      normalized.some((file: string) => file.endsWith("/src/c.txt")),
      false,
    );
  });

  test("ToolSourceParser.walk tolerates unreadable roots", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const unreadable = path.join(
      os.tmpdir(),
      `missing-${Date.now()}-${Math.random()}`,
    );
    const files = (await parser.walk(unreadable, 5)) as string[];

    assert.deepEqual(files, []);
  });

  test("ToolSourceParser.walk handles empty root entries safely", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const files = (await parser.walk("", 2)) as string[];
    assert.deepEqual(files, []);
  });

  test("ToolSourceParser.discoverToolNames enforces max file limits and tolerates missing stats", async () => {
    const lines: string[] = [];
    const output = {
      appendLine: (message: string) => lines.push(message),
    } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "local-qwen-discover-"),
    );
    const firstFile = path.join(tmpRoot, "one.ts");
    const secondFile = path.join(tmpRoot, "two.ts");
    const missingFile = path.join(tmpRoot, "missing.ts");

    await fs.writeFile(
      firstFile,
      "export async function tool_read_file() {}",
      "utf8",
    );
    await fs.writeFile(
      secondFile,
      "const x = functions.run_in_terminal;",
      "utf8",
    );

    const originalGetConfiguration = vscode.workspace.getConfiguration;
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({
        get: (key: string, fallback: unknown) => {
          if (key === "maxToolSourceFiles") {
            return 2;
          }
          if (key === "maxToolSourceBytes") {
            return 300000;
          }
          return fallback;
        },
      }),
    });

    parser.getDiscoveryRoots = async () => [
      tmpRoot,
      path.join(tmpRoot, "other"),
    ];
    parser.walk = async (root: string) =>
      root === tmpRoot ? [missingFile, firstFile, secondFile] : [secondFile];

    try {
      const names = (await parser.discoverToolNames()) as Set<string>;
      const values = [...names].sort();
      assert.equal(values.length, 1);
      assert.equal(values[0], "read_file");
      assert.ok(lines.some((line) => line.includes("from 2 source files")));
    } finally {
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: originalGetConfiguration,
      });
    }
  });

  test("ToolSourceParser.discoverToolNames skips oversized files", async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const parser = new ToolSourceParser(output) as any;

    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "local-qwen-discover-size-"),
    );
    const smallFile = path.join(tmpRoot, "small.ts");
    const largeFile = path.join(tmpRoot, "big.ts");

    await fs.writeFile(
      smallFile,
      "export async function tool_list_dir() {}",
      "utf8",
    );
    await fs.writeFile(
      largeFile,
      `export const payload = \"${"x".repeat(310000)}\";`,
      "utf8",
    );

    const originalGetConfiguration = vscode.workspace.getConfiguration;
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({
        get: (key: string, fallback: unknown) => {
          if (key === "maxToolSourceFiles") {
            return 10;
          }
          if (key === "maxToolSourceBytes") {
            return 300000;
          }
          return fallback;
        },
      }),
    });

    parser.getDiscoveryRoots = async () => [tmpRoot];
    parser.walk = async () => [largeFile, smallFile];

    try {
      const names = (await parser.discoverToolNames()) as Set<string>;
      assert.deepEqual([...names], ["list_dir"]);
    } finally {
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: originalGetConfiguration,
      });
    }
  });

  test("ToolRegistry refreshes executable tools and executes registered handlers", async () => {
    const logs: string[] = [];
    const output = {
      appendLine: (message: string) => logs.push(message),
    } as unknown as vscode.OutputChannel;
    const registry = new ToolRegistry(output) as any;

    registry.parser = {
      discoverToolNames: async () =>
        new Set(["missing_tool", "list_dir", "read_file"]),
    };

    registry.handlerMap = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >([
      [
        "read_file",
        async (args: Record<string, unknown>) => ({ ok: true, args }),
      ],
      ["list_dir", async (_args: Record<string, unknown>) => ({ entries: [] })],
      ["write_file", async (_args: Record<string, unknown>) => ({ ok: true })],
    ]);

    await registry.refresh();

    assert.deepEqual(
      registry.getExecutableTools().map((tool: { name: string }) => tool.name),
      ["list_dir", "read_file"],
    );
    assert.deepEqual(registry.getRegisteredHandlerNames(), [
      "list_dir",
      "read_file",
      "write_file",
    ]);

    const execution = await registry.execute("read_file", {
      filePath: "/tmp/a",
    });
    assert.deepEqual(execution, { ok: true, args: { filePath: "/tmp/a" } });

    await assert.rejects(
      () => registry.execute("missing_tool", {}),
      /No executable handler registered for tool 'missing_tool'\./,
    );

    assert.ok(
      logs.some((line) =>
        line.includes("Executable tools: list_dir, read_file"),
      ),
    );
  });

  test("ToolRegistry refresh logs none when no tools are executable", async () => {
    const logs: string[] = [];
    const output = {
      appendLine: (message: string) => logs.push(message),
    } as unknown as vscode.OutputChannel;
    const registry = new ToolRegistry(output) as any;

    registry.parser = {
      discoverToolNames: async () => new Set(["not_registered"]),
    };

    registry.handlerMap = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >([
      ["read_file", async (_args: Record<string, unknown>) => ({ ok: true })],
    ]);

    await registry.refresh();

    assert.deepEqual(registry.getExecutableTools(), []);
    assert.ok(logs.some((line) => line.includes("Executable tools: (none)")));
  });
});
