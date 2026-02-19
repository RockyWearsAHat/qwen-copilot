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
Object.defineProperty(exports, "__esModule", { value: true });
exports.tool_read_file = tool_read_file;
exports.tool_list_dir = tool_list_dir;
exports.tool_file_search = tool_file_search;
exports.tool_grep_search = tool_grep_search;
exports.tool_run_in_terminal = tool_run_in_terminal;
exports.tool_get_terminal_output = tool_get_terminal_output;
exports.tool_kill_terminal = tool_kill_terminal;
const cp = __importStar(require("node:child_process"));
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const backgroundProcesses = new Map();
function getWorkspaceRoot() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        throw new Error("No workspace is currently open.");
    }
    return root;
}
function isAllowedPath(targetPath) {
    const allowOutsideWorkspace = vscode.workspace
        .getConfiguration("localQwen")
        .get("allowOutsideWorkspaceFileOps", false);
    if (allowOutsideWorkspace) {
        return true;
    }
    const workspaceRoot = getWorkspaceRoot();
    const normalizedRoot = path.resolve(workspaceRoot);
    const normalizedTarget = path.resolve(targetPath);
    return (normalizedTarget === normalizedRoot ||
        normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`));
}
async function readUtf8(filePath) {
    if (!isAllowedPath(filePath)) {
        throw new Error("Path is outside workspace and allowOutsideWorkspaceFileOps is disabled.");
    }
    return fs.readFile(filePath, "utf8");
}
function normalizeNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}
function nextId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function parsePattern(input, isRegexp) {
    if (!isRegexp) {
        const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(escaped, "i");
    }
    return new RegExp(input, "i");
}
async function tool_read_file(args) {
    const filePath = String(args.filePath ?? "");
    if (!filePath) {
        throw new Error("filePath is required.");
    }
    const startLine = Math.max(1, normalizeNumber(args.startLine, 1));
    const endLine = Math.max(startLine, normalizeNumber(args.endLine, startLine + 200));
    const content = await readUtf8(filePath);
    const lines = content.split(/\r?\n/);
    const selected = lines.slice(startLine - 1, endLine);
    return {
        filePath,
        startLine,
        endLine,
        content: selected.join("\n"),
    };
}
async function tool_list_dir(args) {
    const targetPath = String(args.path ?? getWorkspaceRoot());
    if (!isAllowedPath(targetPath)) {
        throw new Error("Path is outside workspace and allowOutsideWorkspaceFileOps is disabled.");
    }
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
}
async function tool_file_search(args) {
    const query = String(args.query ?? "**/*");
    const maxResults = normalizeNumber(args.maxResults, 100);
    const files = await vscode.workspace.findFiles(query, "**/node_modules/**", maxResults);
    return files.map((uri) => uri.fsPath);
}
async function tool_grep_search(args) {
    const query = String(args.query ?? "");
    const isRegexp = Boolean(args.isRegexp ?? false);
    const includePattern = args.includePattern
        ? String(args.includePattern)
        : "**/*";
    const maxResults = normalizeNumber(args.maxResults, 200);
    if (!query) {
        throw new Error("query is required.");
    }
    const regex = parsePattern(query, isRegexp);
    const files = await vscode.workspace.findFiles(includePattern, "**/node_modules/**", maxResults);
    const results = [];
    for (const fileUri of files) {
        if (results.length >= maxResults) {
            break;
        }
        let content = "";
        try {
            content = await fs.readFile(fileUri.fsPath, "utf8");
        }
        catch {
            continue;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
            const text = lines[index];
            if (regex.test(text)) {
                results.push({
                    file: fileUri.fsPath,
                    line: index + 1,
                    text,
                });
            }
        }
    }
    return results;
}
async function tool_run_in_terminal(args) {
    const command = String(args.command ?? "").trim();
    const explanation = String(args.explanation ?? "");
    const goal = String(args.goal ?? "");
    const isBackground = Boolean(args.isBackground ?? false);
    const timeout = normalizeNumber(args.timeout, 0);
    if (!command) {
        throw new Error("command is required.");
    }
    if (!isBackground) {
        return new Promise((resolve, reject) => {
            cp.exec(command, {
                cwd: getWorkspaceRoot(),
                timeout: timeout > 0 ? timeout : undefined,
                shell: "/bin/zsh",
            }, (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        explanation,
                        goal,
                        command,
                        exitCode: error.code ?? 1,
                        stdout,
                        stderr: stderr || error.message,
                    });
                    return;
                }
                resolve({
                    explanation,
                    goal,
                    command,
                    exitCode: 0,
                    stdout,
                    stderr,
                });
            });
        });
    }
    const child = cp.spawn("/bin/zsh", ["-lc", command], {
        cwd: getWorkspaceRoot(),
        detached: false,
    });
    const id = nextId();
    const state = {
        process: child,
        output: "",
    };
    backgroundProcesses.set(id, state);
    child.stdout?.on("data", (chunk) => {
        state.output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
        state.output += chunk.toString();
    });
    child.on("exit", (code, signal) => {
        state.output += `\n[process exited code=${code ?? "null"} signal=${signal ?? "null"}]`;
    });
    return {
        id,
        pid: child.pid,
        status: "running",
    };
}
async function tool_get_terminal_output(args) {
    const id = String(args.id ?? "");
    if (!id) {
        throw new Error("id is required.");
    }
    const processState = backgroundProcesses.get(id);
    if (!processState) {
        throw new Error(`No background process found for id '${id}'.`);
    }
    return {
        id,
        output: processState.output,
    };
}
async function tool_kill_terminal(args) {
    const id = String(args.id ?? "");
    if (!id) {
        throw new Error("id is required.");
    }
    const processState = backgroundProcesses.get(id);
    if (!processState) {
        throw new Error(`No background process found for id '${id}'.`);
    }
    processState.process.kill("SIGTERM");
    backgroundProcesses.delete(id);
    return { id, status: "terminated" };
}
//# sourceMappingURL=handlers.js.map