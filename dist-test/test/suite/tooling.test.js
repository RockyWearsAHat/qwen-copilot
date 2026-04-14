"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const toolRegistry_1 = require("../../src/tools/toolRegistry");
const toolSourceParser_1 = require("../../src/tools/toolSourceParser");
suite("Tooling modules", () => {
    test("ToolSourceParser.getDiscoveryRoots includes workspace and absolute extra roots only", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const absoluteExtraRoot = path.resolve(os.tmpdir(), "local-qwen-extra-root");
        const roots = (await parser.getDiscoveryRoots([
            "relative/path",
            absoluteExtraRoot,
            "",
        ]));
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        strict_1.default.ok(workspaceRoot);
        strict_1.default.ok(roots.includes(workspaceRoot));
        strict_1.default.ok(roots.includes(absoluteExtraRoot));
        strict_1.default.equal(roots.includes("relative/path"), false);
    });
    test("ToolSourceParser.getDiscoveryRoots includes copilot chat extension path when available", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const copilotPath = path.resolve(os.tmpdir(), "copilot-chat-extension");
        const originalGetExtension = vscode.extensions.getExtension;
        Object.defineProperty(vscode.extensions, "getExtension", {
            configurable: true,
            value: (id) => {
                if (id === "GitHub.copilot-chat") {
                    return { extensionPath: copilotPath };
                }
                return undefined;
            },
        });
        try {
            const roots = (await parser.getDiscoveryRoots([]));
            strict_1.default.ok(roots.includes(copilotPath));
        }
        finally {
            Object.defineProperty(vscode.extensions, "getExtension", {
                configurable: true,
                value: originalGetExtension,
            });
        }
    });
    test("ToolSourceParser.getDiscoveryRoots works when no workspace folders are open", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const extraRoot = path.resolve(os.tmpdir(), "local-qwen-root-only-extra");
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
            configurable: true,
            value: undefined,
        });
        try {
            const roots = (await parser.getDiscoveryRoots([extraRoot]));
            strict_1.default.deepEqual(roots, [extraRoot]);
        }
        finally {
            Object.defineProperty(vscode.workspace, "workspaceFolders", {
                configurable: true,
                value: originalWorkspaceFolders,
            });
        }
    });
    test("ToolSourceParser.walk respects budget and filters unsupported entries", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-walk-"));
        const srcDir = path.join(tmpRoot, "src");
        const nodeModulesDir = path.join(tmpRoot, "node_modules");
        const gitDir = path.join(tmpRoot, ".git-hidden");
        await fs.mkdir(srcDir, { recursive: true });
        await fs.mkdir(nodeModulesDir, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(srcDir, "a.ts"), "export const x = 1;", "utf8");
        await fs.writeFile(path.join(srcDir, "b.js"), "module.exports = {};", "utf8");
        await fs.writeFile(path.join(srcDir, "c.txt"), "ignore", "utf8");
        await fs.writeFile(path.join(nodeModulesDir, "skip.ts"), "export {};", "utf8");
        await fs.writeFile(path.join(gitDir, "skip.js"), "export {};", "utf8");
        const symlinkPath = path.join(tmpRoot, "sym");
        await fs.symlink(path.join(srcDir, "a.ts"), symlinkPath);
        const zeroBudget = (await parser.walk(tmpRoot, 0));
        strict_1.default.deepEqual(zeroBudget, []);
        const oneResult = (await parser.walk(tmpRoot, 1));
        strict_1.default.equal(oneResult.length, 1);
        const all = (await parser.walk(tmpRoot, 20));
        const normalized = all.map((item) => item.replace(/\\/g, "/"));
        strict_1.default.ok(normalized.some((file) => file.endsWith("/src/a.ts")));
        strict_1.default.ok(normalized.some((file) => file.endsWith("/src/b.js")));
        strict_1.default.equal(normalized.some((file) => file.includes("/node_modules/")), false);
        strict_1.default.equal(normalized.some((file) => file.includes("/.git-hidden/")), false);
        strict_1.default.equal(normalized.some((file) => file.endsWith("/src/c.txt")), false);
    });
    test("ToolSourceParser.walk tolerates unreadable roots", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const unreadable = path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}`);
        const files = (await parser.walk(unreadable, 5));
        strict_1.default.deepEqual(files, []);
    });
    test("ToolSourceParser.walk handles empty root entries safely", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const files = (await parser.walk("", 2));
        strict_1.default.deepEqual(files, []);
    });
    test("ToolSourceParser.discoverToolNames enforces max file limits and tolerates missing stats", async () => {
        const lines = [];
        const output = {
            appendLine: (message) => lines.push(message),
        };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-discover-"));
        const firstFile = path.join(tmpRoot, "one.ts");
        const secondFile = path.join(tmpRoot, "two.ts");
        const missingFile = path.join(tmpRoot, "missing.ts");
        await fs.writeFile(firstFile, "export async function tool_read_file() {}", "utf8");
        await fs.writeFile(secondFile, "const x = functions.run_in_terminal;", "utf8");
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        Object.defineProperty(vscode.workspace, "getConfiguration", {
            configurable: true,
            value: () => ({
                get: (key, fallback) => {
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
        parser.walk = async (root) => root === tmpRoot ? [missingFile, firstFile, secondFile] : [secondFile];
        try {
            const names = (await parser.discoverToolNames());
            const values = [...names].sort();
            strict_1.default.equal(values.length, 1);
            strict_1.default.equal(values[0], "read_file");
            strict_1.default.ok(lines.some((line) => line.includes("from 2 source files")));
        }
        finally {
            Object.defineProperty(vscode.workspace, "getConfiguration", {
                configurable: true,
                value: originalGetConfiguration,
            });
        }
    });
    test("ToolSourceParser.discoverToolNames skips oversized files", async () => {
        const output = { appendLine: () => { } };
        const parser = new toolSourceParser_1.ToolSourceParser(output);
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-discover-size-"));
        const smallFile = path.join(tmpRoot, "small.ts");
        const largeFile = path.join(tmpRoot, "big.ts");
        await fs.writeFile(smallFile, "export async function tool_list_dir() {}", "utf8");
        await fs.writeFile(largeFile, `export const payload = \"${"x".repeat(310000)}\";`, "utf8");
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        Object.defineProperty(vscode.workspace, "getConfiguration", {
            configurable: true,
            value: () => ({
                get: (key, fallback) => {
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
            const names = (await parser.discoverToolNames());
            strict_1.default.deepEqual([...names], ["list_dir"]);
        }
        finally {
            Object.defineProperty(vscode.workspace, "getConfiguration", {
                configurable: true,
                value: originalGetConfiguration,
            });
        }
    });
    test("ToolRegistry refreshes executable tools and executes registered handlers", async () => {
        const logs = [];
        const output = {
            appendLine: (message) => logs.push(message),
        };
        const registry = new toolRegistry_1.ToolRegistry(output);
        registry.parser = {
            discoverToolNames: async () => new Set(["missing_tool", "list_dir", "read_file"]),
        };
        registry.handlerMap = new Map([
            [
                "read_file",
                async (args) => ({ ok: true, args }),
            ],
            ["list_dir", async (_args) => ({ entries: [] })],
            ["write_file", async (_args) => ({ ok: true })],
        ]);
        await registry.refresh();
        strict_1.default.deepEqual(registry.getExecutableTools().map((tool) => tool.name), ["list_dir", "read_file"]);
        strict_1.default.deepEqual(registry.getRegisteredHandlerNames(), [
            "list_dir",
            "read_file",
            "write_file",
        ]);
        const execution = await registry.execute("read_file", {
            filePath: "/tmp/a",
        });
        strict_1.default.deepEqual(execution, { ok: true, args: { filePath: "/tmp/a" } });
        await strict_1.default.rejects(() => registry.execute("missing_tool", {}), /No executable handler registered for tool 'missing_tool'\./);
        strict_1.default.ok(logs.some((line) => line.includes("Executable tools: list_dir, read_file")));
    });
    test("ToolRegistry refresh logs none when no tools are executable", async () => {
        const logs = [];
        const output = {
            appendLine: (message) => logs.push(message),
        };
        const registry = new toolRegistry_1.ToolRegistry(output);
        registry.parser = {
            discoverToolNames: async () => new Set(["not_registered"]),
        };
        registry.handlerMap = new Map([
            ["read_file", async (_args) => ({ ok: true })],
        ]);
        await registry.refresh();
        strict_1.default.deepEqual(registry.getExecutableTools(), []);
        strict_1.default.ok(logs.some((line) => line.includes("Executable tools: (none)")));
    });
});
//# sourceMappingURL=tooling.test.js.map