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
exports.__selectBestMacWindowForTest = __selectBestMacWindowForTest;
exports.tool_read_file = tool_read_file;
exports.tool_write_file = tool_write_file;
exports.tool_edit_file = tool_edit_file;
exports.tool_list_dir = tool_list_dir;
exports.tool_file_search = tool_file_search;
exports.tool_grep_search = tool_grep_search;
exports.tool_replace_in_files = tool_replace_in_files;
exports.tool_run_in_terminal = tool_run_in_terminal;
exports.tool_get_terminal_output = tool_get_terminal_output;
exports.tool_kill_terminal = tool_kill_terminal;
exports.cleanupBackgroundProcesses = cleanupBackgroundProcesses;
exports.tool_get_completion_checklist = tool_get_completion_checklist;
exports.tool_create_agent_checklist = tool_create_agent_checklist;
exports.tool_get_agent_checklist = tool_get_agent_checklist;
exports.tool_update_agent_checklist_item = tool_update_agent_checklist_item;
exports.tool_take_screenshot = tool_take_screenshot;
exports.tool_ocr_find_text = tool_ocr_find_text;
exports.tool_gui_key_hold = tool_gui_key_hold;
exports.tool_analyze_image = tool_analyze_image;
exports.tool_gui_click = tool_gui_click;
exports.tool_gui_type = tool_gui_type;
exports.tool_gui_scroll = tool_gui_scroll;
exports.tool_gui_key = tool_gui_key;
exports.tool_list_windows = tool_list_windows;
exports.tool_focus_window = tool_focus_window;
exports.tool_launch_app = tool_launch_app;
exports.tool_wait_for_condition = tool_wait_for_condition;
exports.tool_get_diagnostics = tool_get_diagnostics;
exports.tool_get_workspace_symbols = tool_get_workspace_symbols;
exports.tool_get_document_symbols = tool_get_document_symbols;
exports.tool_get_references = tool_get_references;
exports.tool_get_definition = tool_get_definition;
exports.tool_http_request = tool_http_request;
exports.getAgentState = getAgentState;
exports.resetAgentState = resetAgentState;
exports.tool_agent_progress = tool_agent_progress;
const cp = __importStar(require("node:child_process"));
const terminalPolicy_1 = require("./terminalPolicy");
const fs = __importStar(require("node:fs/promises"));
const net = __importStar(require("node:net"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_util_1 = require("node:util");
const vscode = __importStar(require("vscode"));
const execFileAsync = (0, node_util_1.promisify)(cp.execFile);
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// macOS: AppleScript-free window enumeration (for deterministic screenshots)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MAC_WINDOW_INFO_SWIFT = `
import Foundation
import CoreGraphics

struct WindowBounds: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct WindowInfo: Codable {
  let id: Int
  let app: String
  let title: String
  let pid: Int?
  let layer: Int?
  let alpha: Double?
  let bounds: WindowBounds?
}

func intValue(_ v: Any?) -> Int? {
  if let n = v as? Int { return n }
  if let n = v as? NSNumber { return n.intValue }
  return nil
}

func doubleValue(_ v: Any?) -> Double? {
  if let n = v as? Double { return n }
  if let n = v as? NSNumber { return n.doubleValue }
  return nil
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as NSArray? ?? []

var out: [WindowInfo] = []
out.reserveCapacity(list.count)

for entry in list {
  guard let dict = entry as? NSDictionary else { continue }
  let id = intValue(dict[kCGWindowNumber]) ?? 0
  if id == 0 { continue }

  let app = (dict[kCGWindowOwnerName] as? String) ?? ""
  let title = (dict[kCGWindowName] as? String) ?? ""
  let pid = intValue(dict[kCGWindowOwnerPID])
  let layer = intValue(dict[kCGWindowLayer])
  let alpha = doubleValue(dict[kCGWindowAlpha])

  var bounds: WindowBounds? = nil
  if let b = dict[kCGWindowBounds] as? NSDictionary {
    if let x = doubleValue(b["X"]), let y = doubleValue(b["Y"]), let w = doubleValue(b["Width"]), let h = doubleValue(b["Height"]) {
      bounds = WindowBounds(x: x, y: y, width: w, height: h)
    }
  }

  out.append(WindowInfo(id: id, app: app, title: title, pid: pid, layer: layer, alpha: alpha, bounds: bounds))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]

if let data = try? encoder.encode(out) {
  FileHandle.standardOutput.write(data)
}
`;
function normalizeNeedle(value) {
    return value.trim().toLowerCase();
}
function boundsArea(bounds) {
    if (!bounds)
        return 0;
    const w = Number(bounds.width);
    const h = Number(bounds.height);
    if (!Number.isFinite(w) || !Number.isFinite(h))
        return 0;
    return Math.max(0, w) * Math.max(0, h);
}
function __selectBestMacWindowForTest(windows, needleRaw) {
    const needle = normalizeNeedle(needleRaw);
    if (!needle)
        return undefined;
    const candidates = windows
        .filter((w) => (w.layer ?? 0) === 0)
        .filter((w) => (typeof w.alpha === "number" ? w.alpha > 0 : true))
        .filter((w) => w.id > 0);
    const score = (w) => {
        const app = normalizeNeedle(w.app ?? "");
        const title = normalizeNeedle(w.title ?? "");
        let s = 0;
        if (title === needle)
            s += 1200;
        if (app === needle)
            s += 900;
        if (title.includes(needle))
            s += 700;
        if (app.includes(needle))
            s += 450;
        if (title.length > 0)
            s += 50;
        s += Math.min(400, Math.round(boundsArea(w.bounds) / 5000));
        return s;
    };
    let best;
    let bestScore = -1;
    for (const w of candidates) {
        const s = score(w);
        if (s > bestScore) {
            bestScore = s;
            best = w;
        }
    }
    if (!best || bestScore < 450)
        return undefined;
    return best;
}
async function ensureMacWindowInfoBinary() {
    const baseDir = path.join(os.tmpdir(), "local-qwen-mac-window-helper");
    const srcPath = path.join(baseDir, "window_info.swift");
    const binPath = path.join(baseDir, "window_info");
    await fs.mkdir(baseDir, { recursive: true });
    let needsWrite = false;
    try {
        const current = await fs.readFile(srcPath, "utf8");
        if (current !== MAC_WINDOW_INFO_SWIFT)
            needsWrite = true;
    }
    catch {
        needsWrite = true;
    }
    if (needsWrite) {
        await fs.writeFile(srcPath, MAC_WINDOW_INFO_SWIFT, "utf8");
    }
    let binMtime = 0;
    let srcMtime = 0;
    try {
        binMtime = (await fs.stat(binPath)).mtimeMs;
    }
    catch {
        binMtime = 0;
    }
    try {
        srcMtime = (await fs.stat(srcPath)).mtimeMs;
    }
    catch {
        srcMtime = 0;
    }
    if (!binMtime || (srcMtime && srcMtime > binMtime)) {
        await execFileAsync("xcrun", [
            "swiftc",
            srcPath,
            "-O",
            "-framework",
            "CoreGraphics",
            "-framework",
            "Foundation",
            "-o",
            binPath,
        ]);
    }
    return binPath;
}
async function listMacWindowsViaSwift() {
    const bin = await ensureMacWindowInfoBinary();
    const { stdout } = await execFileAsync(bin, [], { maxBuffer: 5 * 1024 * 1024 });
    const raw = String(stdout ?? "").trim();
    if (!raw)
        return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((w) => typeof w?.id === "number");
}
async function listMacWindowsViaYabai() {
    const { stdout } = await execFileAsync("yabai", ["-m", "query", "--windows"], {
        maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout ?? ""));
    if (!Array.isArray(parsed))
        return [];
    return parsed
        .filter((w) => Boolean(w && (w["is-visible"] ?? w.visible ?? true)))
        .map((w) => {
        const frame = w.frame ?? w.bounds;
        const bounds = frame &&
            Number.isFinite(frame.x) &&
            Number.isFinite(frame.y) &&
            Number.isFinite(frame.w) &&
            Number.isFinite(frame.h)
            ? {
                x: Number(frame.x),
                y: Number(frame.y),
                width: Number(frame.w),
                height: Number(frame.h),
            }
            : undefined;
        return {
            id: Number(w.id),
            app: String(w.app ?? ""),
            title: String(w.title ?? ""),
            pid: typeof w.pid === "number" ? w.pid : undefined,
            layer: 0,
            alpha: 1,
            bounds,
        };
    })
        .filter((w) => Number.isFinite(w.id) && w.id > 0);
}
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
async function writeUtf8(filePath, content) {
    if (!isAllowedPath(filePath)) {
        throw new Error("Path is outside workspace and allowOutsideWorkspaceFileOps is disabled.");
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
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
function normalizePathLikeQuery(input) {
    return input
        .trim()
        .replace(/^['"`]|['"`]$/g, "")
        .replace(/\\/g, "/")
        .replace(/\s*\/\s*/g, "/")
        .replace(/\/+/g, "/");
}
function isLikelyGlobPattern(query) {
    return /[*?{}\[\]]/.test(query);
}
function toFileSearchGlobCandidates(rawQuery) {
    const normalized = normalizePathLikeQuery(rawQuery);
    if (!normalized) {
        return ["**/*"];
    }
    if (isLikelyGlobPattern(normalized)) {
        return [normalized];
    }
    const withoutLeadingSlash = normalized.replace(/^\//, "");
    const basename = path.posix.basename(withoutLeadingSlash);
    const basenameNoExt = basename.replace(/\.[^.]+$/, "");
    const candidates = [
        `**/${withoutLeadingSlash}`,
        `**/${basename}`,
        basenameNoExt ? `**/${basenameNoExt}*` : "",
    ].filter((candidate) => candidate.length > 0);
    return [...new Set(candidates)];
}
async function grepInFiles(files, regex, maxResults) {
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
function toGrepFallbackQueries(rawQuery) {
    const normalized = normalizePathLikeQuery(rawQuery);
    if (!normalized) {
        return [];
    }
    const hasPathSeparators = normalized.includes("/");
    const withoutLeadingSlash = normalized.replace(/^\//, "");
    const basename = path.posix.basename(withoutLeadingSlash);
    const candidates = [
        normalized,
        withoutLeadingSlash,
        basename,
        hasPathSeparators ? withoutLeadingSlash.replace(/\s+/g, "") : "",
    ].filter((candidate) => candidate.length >= 2);
    return [...new Set(candidates)];
}
function escapeRegexLiteral(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function countOccurrences(haystack, needle) {
    if (!needle) {
        return 0;
    }
    let count = 0;
    let offset = 0;
    while (offset <= haystack.length) {
        const index = haystack.indexOf(needle, offset);
        if (index < 0) {
            break;
        }
        count += 1;
        offset = index + needle.length;
    }
    return count;
}
function shouldSkipBulkReplacePath(filePath) {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    return (normalized.includes("/node_modules/") ||
        normalized.includes("/.git/") ||
        normalized.includes("/dist/") ||
        normalized.includes("/dist-test/") ||
        normalized.endsWith("/package-lock.json"));
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
async function tool_write_file(args) {
    const filePath = String(args.filePath ?? "");
    if (!filePath) {
        throw new Error("filePath is required.");
    }
    const content = typeof args.content === "string"
        ? args.content
        : typeof args.text === "string"
            ? args.text
            : "";
    const allowOverwrite = args.overwrite ? Boolean(args.overwrite) : true;
    if (!allowOverwrite) {
        try {
            await fs.access(filePath);
            throw new Error("File already exists and overwrite=false. Refusing to overwrite.");
        }
        catch {
            // ok (does not exist)
        }
    }
    await writeUtf8(filePath, content);
    return { filePath, bytesWritten: Buffer.byteLength(content, "utf8") };
}
async function tool_edit_file(args) {
    const filePath = String(args.filePath ?? "");
    if (!filePath) {
        throw new Error("filePath is required.");
    }
    const startLine = Math.max(1, normalizeNumber(args.startLine, 1));
    const endLine = Math.max(startLine, normalizeNumber(args.endLine, startLine));
    const newText = typeof args.newText === "string"
        ? args.newText
        : typeof args.content === "string"
            ? args.content
            : typeof args.text === "string"
                ? args.text
                : "";
    const content = await readUtf8(filePath);
    const lines = content.split(/\r?\n/);
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const replacementLines = newText.length > 0 ? newText.split(/\r?\n/) : [];
    const nextLines = [...before, ...replacementLines, ...after];
    const nextContent = nextLines.join("\n");
    await writeUtf8(filePath, nextContent);
    return {
        filePath,
        startLine,
        endLine,
        replacedLineCount: endLine - startLine + 1,
        insertedLineCount: replacementLines.length,
    };
}
async function tool_list_dir(args) {
    const targetPath = String(args.path ?? getWorkspaceRoot());
    if (!isAllowedPath(targetPath)) {
        throw new Error("Path is outside workspace and allowOutsideWorkspaceFileOps is disabled.");
    }
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
}
async function tool_file_search(args) {
    const query = String(args.query ?? "**/*");
    const maxResults = normalizeNumber(args.maxResults, 100);
    const candidates = toFileSearchGlobCandidates(query);
    const seen = new Set();
    const results = [];
    for (const candidate of candidates) {
        if (results.length >= maxResults) {
            break;
        }
        const files = await vscode.workspace.findFiles(candidate, "**/node_modules/**", maxResults);
        for (const uri of files) {
            if (results.length >= maxResults) {
                break;
            }
            if (seen.has(uri.fsPath)) {
                continue;
            }
            seen.add(uri.fsPath);
            results.push(uri.fsPath);
        }
    }
    return results;
}
async function tool_grep_search(args) {
    const query = String(args.query ?? "");
    const isRegexp = Boolean(args.isRegexp ?? false);
    const includePattern = args.includePattern ? String(args.includePattern) : "**/*";
    const maxResults = normalizeNumber(args.maxResults, 200);
    if (!query) {
        throw new Error("query is required.");
    }
    const regex = parsePattern(query, isRegexp);
    const fileSearchLimit = Math.max(maxResults * 5, 400);
    const files = await vscode.workspace.findFiles(includePattern, "**/node_modules/**", fileSearchLimit);
    const exactResults = await grepInFiles(files, regex, maxResults);
    if (exactResults.length > 0 || isRegexp) {
        return exactResults;
    }
    const fallbackQueries = toGrepFallbackQueries(query);
    for (const fallbackQuery of fallbackQueries) {
        if (fallbackQuery === query) {
            continue;
        }
        const fallbackRegex = parsePattern(fallbackQuery, false);
        const fallbackResults = await grepInFiles(files, fallbackRegex, maxResults);
        if (fallbackResults.length > 0) {
            return fallbackResults;
        }
    }
    return exactResults;
}
async function tool_replace_in_files(args) {
    const from = String(args.from ?? args.search ?? "");
    const to = String(args.to ?? args.replace ?? "");
    const includePattern = args.includePattern ? String(args.includePattern) : "**/*";
    const excludePattern = args.excludePattern
        ? String(args.excludePattern)
        : "**/{node_modules,.git,dist,dist-test}/**";
    const maxFiles = Math.max(1, Math.min(5000, normalizeNumber(args.maxFiles, 1500)));
    const dryRun = Boolean(args.dryRun ?? false);
    const caseSensitive = Boolean(args.caseSensitive ?? true);
    if (!from) {
        throw new Error("from is required.");
    }
    if (from === to) {
        return {
            from,
            to,
            includePattern,
            excludePattern,
            maxFiles,
            dryRun,
            filesScanned: 0,
            filesChanged: 0,
            replacements: 0,
            changedFiles: [],
            note: "No-op replacement because from and to are identical.",
        };
    }
    const files = await vscode.workspace.findFiles(includePattern, excludePattern, maxFiles);
    const changedFiles = [];
    let filesScanned = 0;
    let filesChanged = 0;
    let replacements = 0;
    const replaceRegex = caseSensitive ? undefined : new RegExp(escapeRegexLiteral(from), "gi");
    for (const fileUri of files) {
        const filePath = fileUri.fsPath;
        if (shouldSkipBulkReplacePath(filePath)) {
            continue;
        }
        filesScanned += 1;
        let content = "";
        try {
            content = await fs.readFile(filePath, "utf8");
        }
        catch {
            continue;
        }
        let replaced = "";
        let replaceCount = 0;
        if (caseSensitive) {
            replaceCount = countOccurrences(content, from);
            if (replaceCount === 0) {
                continue;
            }
            replaced = content.split(from).join(to);
        }
        else {
            const matches = content.match(replaceRegex);
            replaceCount = matches?.length ?? 0;
            if (replaceCount === 0) {
                continue;
            }
            replaced = content.replace(replaceRegex, to);
        }
        filesChanged += 1;
        replacements += replaceCount;
        changedFiles.push({ file: filePath, replacements: replaceCount });
        if (!dryRun) {
            await writeUtf8(filePath, replaced);
        }
    }
    return {
        from,
        to,
        includePattern,
        excludePattern,
        maxFiles,
        dryRun,
        caseSensitive,
        filesScanned,
        filesChanged,
        replacements,
        changedFiles,
    };
}
async function tool_run_in_terminal(args) {
    const command = String(args.command ?? "").trim();
    const explanation = String(args.explanation ?? "");
    const goal = String(args.goal ?? "");
    const isBackground = Boolean(args.isBackground ?? false);
    const showTerminal = Boolean(args.showTerminal ?? false);
    const timeout = normalizeNumber(args.timeout, 0);
    if (!command) {
        throw new Error("command is required.");
    }
    const violation = (0, terminalPolicy_1.getTerminalPolicyViolation)(command);
    if (violation) {
        return {
            explanation,
            goal,
            command,
            exitCode: 2,
            stdout: "",
            stderr: violation,
        };
    }
    if (showTerminal) {
        const terminal = vscode.window.createTerminal({
            name: `local-qwen: ${goal || "run command"}`.slice(0, 48),
            cwd: getWorkspaceRoot(),
        });
        terminal.show(false);
        terminal.sendText(command, true);
        if (isBackground) {
            const id = nextId();
            const state = {
                kind: "terminal",
                terminal,
                output: "",
            };
            backgroundProcesses.set(id, state);
            return {
                id,
                pid: null,
                status: "running",
                visibleTerminal: true,
                note: "Started in visible VS Code terminal. Output streaming is available in the Terminal panel.",
            };
        }
        return {
            explanation,
            goal,
            command,
            exitCode: null,
            stdout: "",
            stderr: "",
            visibleTerminal: true,
            note: "Command was sent to a visible VS Code terminal and runs asynchronously.",
        };
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
        kind: "process",
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
    if (processState.kind === "terminal") {
        return {
            id,
            output: processState.output,
            visibleTerminal: true,
            note: "Output capture is not available for visible VS Code terminal sessions. Read output from the Terminal panel.",
        };
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
    if (processState.kind === "terminal") {
        processState.terminal.dispose();
    }
    else {
        processState.process.kill("SIGTERM");
    }
    backgroundProcesses.delete(id);
    return { id, status: "terminated" };
}
/**
 * Terminate all tracked background processes and clear the process map.
 * Called from extension.deactivate() to avoid orphaned child processes.
 */
function cleanupBackgroundProcesses() {
    for (const [id, state] of backgroundProcesses) {
        try {
            if (state.kind === "terminal") {
                state.terminal.dispose();
            }
            else {
                state.process.kill("SIGTERM");
            }
        }
        catch {
            // process may have already exited; ignore
        }
        backgroundProcesses.delete(id);
    }
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Completion Checklist
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tool_get_completion_checklist(_args) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return { content: "", exists: false, message: "No workspace folder open." };
    }
    const checklistPath = path.join(workspaceFolders[0].uri.fsPath, ".github", "completion-checklist.md");
    try {
        const content = await fs.readFile(checklistPath, "utf-8");
        const lines = content.split("\n");
        const items = [];
        lines.forEach((line, idx) => {
            const match = line.match(/^(\s*[-*]\s*)\[([xX ])\]\s*(.+)$/);
            if (match) {
                items.push({
                    text: match[3].trim(),
                    checked: match[2].toLowerCase() === "x",
                    line: idx + 1,
                });
            }
        });
        const totalItems = items.length;
        const completedItems = items.filter((i) => i.checked).length;
        const allComplete = totalItems > 0 && completedItems === totalItems;
        return {
            exists: true,
            content,
            items,
            totalItems,
            completedItems,
            allComplete,
            summary: allComplete
                ? "ALL checklist items are complete."
                : `${completedItems}/${totalItems} checklist items complete. Remaining: ${items
                    .filter((i) => !i.checked)
                    .map((i) => i.text)
                    .join(", ")}`,
        };
    }
    catch {
        return {
            content: "",
            exists: false,
            items: [],
            totalItems: 0,
            completedItems: 0,
            allComplete: true,
            message: "No .github/completion-checklist.md found. Create one to define acceptance criteria.",
        };
    }
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Agent Internal Checklist  (.github/agent-checklist.md)
//
// Entirely separate from the USER's .github/completion-checklist.md.
// The user's file is the acceptance gate and is NEVER written by the agent.
// This file is created fresh per request as the agent's detailed work plan.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const AGENT_CHECKLIST_FILENAME = "agent-checklist.md";
function getAgentChecklistPath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0)
        return null;
    return path.join(workspaceFolders[0].uri.fsPath, ".github", AGENT_CHECKLIST_FILENAME);
}
/**
 * Create (or fully replace) .github/agent-checklist.md.
 * The USER's completion-checklist.md is NEVER touched by this function.
 */
async function tool_create_agent_checklist(args) {
    const title = String(args.title ?? "Agent Work Plan");
    const rawItems = args.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return { success: false, error: "items must be a non-empty array of strings." };
    }
    const items = rawItems.map((i) => String(i));
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return { success: false, error: "No workspace folder open." };
    }
    const githubDir = path.join(workspaceFolders[0].uri.fsPath, ".github");
    const checklistPath = path.join(githubDir, AGENT_CHECKLIST_FILENAME);
    try {
        await fs.mkdir(githubDir, { recursive: true });
        const lines = [
            `# ${title}`,
            "",
            `<!-- Agent internal work plan — generated ${new Date().toISOString()} -->`,
            "<!-- Do NOT confuse with completion-checklist.md (the user's acceptance gate). -->",
            "",
            ...items.map((item) => `- [ ] ${item}`),
            "",
        ];
        await fs.writeFile(checklistPath, lines.join("\n"), "utf-8");
        return {
            success: true,
            path: checklistPath,
            totalItems: items.length,
            message: `Created agent work plan with ${items.length} items in ${AGENT_CHECKLIST_FILENAME}.`,
        };
    }
    catch (err) {
        return {
            success: false,
            error: `Failed to create ${AGENT_CHECKLIST_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
/** Read and parse .github/agent-checklist.md. */
async function tool_get_agent_checklist(_args) {
    const checklistPath = getAgentChecklistPath();
    if (!checklistPath) {
        return {
            exists: false,
            items: [],
            totalItems: 0,
            completedItems: 0,
            allComplete: false,
            message: "No workspace folder open.",
        };
    }
    try {
        const content = await fs.readFile(checklistPath, "utf-8");
        const lines = content.split("\n");
        const items = [];
        lines.forEach((line, idx) => {
            const match = line.match(/^(\s*[-*]\s*)\[([xX ])\]\s*(.+)$/);
            if (match) {
                items.push({
                    text: match[3].trim(),
                    checked: match[2].toLowerCase() === "x",
                    line: idx + 1,
                });
            }
        });
        const completedItems = items.filter((i) => i.checked).length;
        const totalItems = items.length;
        const allComplete = totalItems > 0 && completedItems === totalItems;
        return {
            exists: true,
            content,
            items,
            totalItems,
            completedItems,
            allComplete,
            summary: allComplete
                ? "ALL agent checklist items are complete."
                : `${completedItems}/${totalItems} items done. Remaining: ${items
                    .filter((i) => !i.checked)
                    .map((i) => i.text)
                    .join(", ")}`,
        };
    }
    catch {
        return {
            exists: false,
            items: [],
            totalItems: 0,
            completedItems: 0,
            allComplete: false,
            message: `No ${AGENT_CHECKLIST_FILENAME} found. Call create_agent_checklist to start one.`,
        };
    }
}
/** Mark a single item in .github/agent-checklist.md as checked or unchecked. */
async function tool_update_agent_checklist_item(args) {
    const itemText = String(args.itemText ?? "");
    const checked = Boolean(args.checked);
    if (!itemText) {
        return { success: false, error: "itemText is required." };
    }
    const checklistPath = getAgentChecklistPath();
    if (!checklistPath) {
        return { success: false, error: "No workspace folder open." };
    }
    try {
        const content = await fs.readFile(checklistPath, "utf-8");
        const lines = content.split("\n");
        let updated = false;
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(\s*[-*]\s*)\[([xX ])\]\s*(.+)$/);
            if (match && match[3].toLowerCase().includes(itemText.toLowerCase())) {
                lines[i] = `${match[1]}[${checked ? "x" : " "}] ${match[3]}`;
                updated = true;
                break;
            }
        }
        if (!updated) {
            return { success: false, error: `No agent checklist item matching "${itemText}" found.` };
        }
        await fs.writeFile(checklistPath, lines.join("\n"), "utf-8");
        return {
            success: true,
            message: `Marked "${itemText}" as ${checked ? "done" : "not done"} in ${AGENT_CHECKLIST_FILENAME}.`,
        };
    }
    catch {
        return { success: false, error: `Failed to read or write ${AGENT_CHECKLIST_FILENAME}.` };
    }
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vision / Screenshot
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tool_take_screenshot(args) {
    const windowTitle = args.windowTitle;
    const region = args.region;
    const delay = Number(args.delay ?? 0);
    let note;
    const meta = {
        platform: process.platform,
    };
    const tmpFile = path.join(os.tmpdir(), `copilot-screenshot-${Date.now()}.png`);
    try {
        const platform = process.platform;
        if (platform === "darwin") {
            const captureArgs = [];
            if (delay > 0) {
                captureArgs.push("-T", String(Math.ceil(delay)));
            }
            if (windowTitle) {
                meta.capture = "window";
                // Deterministic, non-interactive window targeting:
                // 1) enumerate windows via Swift helper (CGWindowListCopyWindowInfo)
                // 2) pick best match by app/title
                // 3) capture with `screencapture -l <id>`
                let windows = [];
                try {
                    windows = await listMacWindowsViaSwift();
                }
                catch (err) {
                    try {
                        windows = await listMacWindowsViaYabai();
                        note = "macOS window enumeration used yabai (Swift helper unavailable).";
                    }
                    catch {
                        const message = err instanceof Error ? err.message : String(err);
                        return {
                            success: false,
                            error: `macOS window capture requires window enumeration tooling. ` +
                                `Swift helper failed: ${message}. Install Xcode Command Line Tools (xcrun/swiftc) or install yabai, then try again.`,
                        };
                    }
                }
                const best = __selectBestMacWindowForTest(windows, windowTitle);
                if (!best) {
                    const examples = windows
                        .filter((w) => (w.layer ?? 0) === 0)
                        .slice(0, 8)
                        .map((w) => `${w.app}${w.title ? ` — ${w.title}` : ""}`)
                        .filter(Boolean);
                    return {
                        success: false,
                        error: `No on-screen window matched "${windowTitle}". ` +
                            (examples.length ? `Examples: ${examples.join(" | ")}` : "No visible windows found."),
                    };
                }
                if (best.bounds) {
                    meta.origin = { x: best.bounds.x, y: best.bounds.y };
                    meta.size = { width: best.bounds.width, height: best.bounds.height };
                }
                captureArgs.push("-x", "-l", String(best.id));
            }
            else if (region) {
                meta.capture = "region";
                meta.origin = { x: region.x, y: region.y };
                meta.size = { width: region.width, height: region.height };
                captureArgs.push("-R", `${region.x},${region.y},${region.width},${region.height}`);
            }
            else {
                meta.capture = "screen";
                meta.origin = { x: 0, y: 0 };
            }
            captureArgs.push(tmpFile);
            await execFileAsync("screencapture", captureArgs);
        }
        else if (platform === "win32") {
            meta.capture = region ? "region" : windowTitle ? "window" : "screen";
            if (region) {
                meta.origin = { x: region.x, y: region.y };
                meta.size = { width: region.width, height: region.height };
            }
            else {
                meta.origin = { x: 0, y: 0 };
            }
            // Use PowerShell + .NET to capture a screenshot without external deps.
            // Note: windowTitle targeting is best-effort only (we capture screen/region).
            const rectScript = region
                ? `$x=${Math.trunc(region.x)}; $y=${Math.trunc(region.y)}; $w=${Math.trunc(region.width)}; $h=${Math.trunc(region.height)};`
                : `$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen; $x=$bounds.X; $y=$bounds.Y; $w=$bounds.Width; $h=$bounds.Height;`;
            const sleepScript = delay > 0 ? `Start-Sleep -Milliseconds ${Math.trunc(delay * 1000)};` : "";
            const escapedOut = tmpFile.replace(/'/g, "''");
            const ps = [
                "Add-Type -AssemblyName System.Windows.Forms;",
                "Add-Type -AssemblyName System.Drawing;",
                sleepScript,
                rectScript,
                `$bmp = New-Object System.Drawing.Bitmap $w, $h;`,
                `$g = [System.Drawing.Graphics]::FromImage($bmp);`,
                `$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size);`,
                `$bmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Png);`,
                "$g.Dispose(); $bmp.Dispose();",
            ]
                .filter(Boolean)
                .join(" ");
            await execFileAsync("powershell", ["-NoProfile", "-Command", ps]);
        }
        else {
            if (delay > 0) {
                await new Promise((r) => setTimeout(r, delay * 1000));
            }
            try {
                const scrotArgs = [];
                if (windowTitle) {
                    meta.capture = "window";
                    scrotArgs.push("-u");
                }
                if (region) {
                    meta.capture = "region";
                    meta.origin = { x: region.x, y: region.y };
                    meta.size = { width: region.width, height: region.height };
                    scrotArgs.push("-a", `${region.x},${region.y},${region.width},${region.height}`);
                }
                if (!windowTitle && !region) {
                    meta.capture = "screen";
                    meta.origin = { x: 0, y: 0 };
                }
                scrotArgs.push(tmpFile);
                await execFileAsync("scrot", scrotArgs);
            }
            catch {
                meta.capture = "screen";
                meta.origin = { x: 0, y: 0 };
                await execFileAsync("gnome-screenshot", ["-f", tmpFile]);
            }
        }
        const imageBuffer = await fs.readFile(tmpFile);
        const base64 = imageBuffer.toString("base64");
        await fs.unlink(tmpFile).catch(() => { });
        return {
            success: true,
            image: base64,
            format: "png",
            sizeBytes: imageBuffer.length,
            meta,
            ...(note ? { note } : {}),
            message: `Screenshot captured (${imageBuffer.length} bytes).`,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Screenshot failed: ${message}` };
    }
}
function parseTesseractTsv(tsv) {
    const lines = tsv.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) {
        return [];
    }
    const rows = [];
    for (const raw of lines.slice(1)) {
        const parts = raw.split("\t");
        if (parts.length < 12) {
            continue;
        }
        const [level, page, block, par, line, word, left, top, width, height, conf, ...textParts] = parts;
        const text = textParts.join("\t").trim();
        rows.push({
            level: Number(level),
            page: Number(page),
            block: Number(block),
            par: Number(par),
            line: Number(line),
            word: Number(word),
            left: Number(left),
            top: Number(top),
            width: Number(width),
            height: Number(height),
            conf: Number(conf),
            text,
        });
    }
    return rows.filter((row) => [
        row.level,
        row.page,
        row.block,
        row.par,
        row.line,
        row.word,
        row.left,
        row.top,
        row.width,
        row.height,
        row.conf,
    ].every((n) => Number.isFinite(n)));
}
async function tool_ocr_find_text(args) {
    const imageBase64 = String(args.image ?? "");
    const query = String(args.query ?? "");
    const isRegexp = Boolean(args.isRegexp ?? false);
    const maxResults = Math.max(1, Number(args.maxResults ?? 20));
    const minConfidence = Number(args.minConfidence ?? 0);
    const originInput = args.origin;
    const origin = {
        x: originInput && Number.isFinite(Number(originInput.x)) ? Number(originInput.x) : 0,
        y: originInput && Number.isFinite(Number(originInput.y)) ? Number(originInput.y) : 0,
    };
    if (!imageBase64) {
        return { success: false, error: "image is required (base64 PNG/JPEG)." };
    }
    if (!query) {
        return { success: false, error: "query is required." };
    }
    const regex = parsePattern(query, isRegexp);
    const tmpPng = path.join(os.tmpdir(), `copilot-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
        const buffer = Buffer.from(imageBase64, "base64");
        await fs.writeFile(tmpPng, buffer);
        const { stdout } = await execFileAsync("tesseract", [tmpPng, "stdout", "--psm", "6", "tsv"]);
        const rows = parseTesseractTsv(stdout)
            .filter((row) => row.level === 5)
            .filter((row) => row.text.length > 0)
            .filter((row) => row.conf >= minConfidence);
        const lineKey = (row) => `${row.page}:${row.block}:${row.par}:${row.line}`;
        const grouped = new Map();
        for (const row of rows) {
            const key = lineKey(row);
            const existing = grouped.get(key);
            if (existing) {
                existing.push(row);
            }
            else {
                grouped.set(key, [row]);
            }
        }
        const lineMatches = [];
        for (const words of grouped.values()) {
            words.sort((a, b) => a.left - b.left);
            const text = words
                .map((w) => w.text)
                .join(" ")
                .trim();
            if (!text) {
                continue;
            }
            if (!regex.test(text)) {
                continue;
            }
            const left = Math.min(...words.map((w) => w.left));
            const top = Math.min(...words.map((w) => w.top));
            const right = Math.max(...words.map((w) => w.left + w.width));
            const bottom = Math.max(...words.map((w) => w.top + w.height));
            const confidence = words.reduce((sum, w) => sum + (Number.isFinite(w.conf) ? w.conf : 0), 0) / words.length;
            const bbox = { x: left, y: top, width: right - left, height: bottom - top };
            const center = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
            const absoluteCenter = { x: origin.x + center.x, y: origin.y + center.y };
            lineMatches.push({
                text,
                confidence,
                bbox,
                center,
                absoluteCenter,
                matchType: "line",
            });
        }
        if (lineMatches.length === 0) {
            for (const w of rows) {
                if (lineMatches.length >= maxResults) {
                    break;
                }
                if (!regex.test(w.text)) {
                    continue;
                }
                const bbox = { x: w.left, y: w.top, width: w.width, height: w.height };
                const center = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
                const absoluteCenter = { x: origin.x + center.x, y: origin.y + center.y };
                lineMatches.push({
                    text: w.text,
                    confidence: w.conf,
                    bbox,
                    center,
                    absoluteCenter,
                    matchType: "word",
                });
            }
        }
        const matches = lineMatches.slice(0, maxResults);
        return {
            success: true,
            engine: "tesseract",
            query,
            isRegexp,
            origin,
            matchCount: matches.length,
            matches,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            error: `OCR failed: ${message}. Install tesseract (macOS: 'brew install tesseract').`,
        };
    }
    finally {
        await fs.unlink(tmpPng).catch(() => { });
    }
}
async function tool_gui_key_hold(args) {
    const key = String(args.key ?? "");
    const durationMs = Math.max(0, Number(args.durationMs ?? 300));
    if (!key) {
        return { success: false, error: "key is required." };
    }
    try {
        if (process.platform === "darwin") {
            // cliclick supports key down/up for common keys (notably modifiers). For non-modifiers, fall back to a normal key press.
            const lower = key.toLowerCase();
            const known = new Set(["cmd", "command", "ctrl", "control", "alt", "option", "shift"]);
            if (known.has(lower)) {
                const normalized = lower === "cmd" || lower === "command"
                    ? "cmd"
                    : lower === "ctrl" || lower === "control"
                        ? "ctrl"
                        : lower === "alt" || lower === "option"
                            ? "alt"
                            : "shift";
                await execFileAsync("cliclick", [`kd:${normalized}`]);
                if (durationMs > 0) {
                    await new Promise((r) => setTimeout(r, durationMs));
                }
                await execFileAsync("cliclick", [`ku:${normalized}`]);
            }
            else {
                await tool_gui_key({ key });
            }
        }
        else {
            await execFileAsync("xdotool", ["keydown", key]);
            if (durationMs > 0) {
                await new Promise((r) => setTimeout(r, durationMs));
            }
            await execFileAsync("xdotool", ["keyup", key]);
        }
        return { success: true, message: `Held ${key} for ${durationMs}ms.` };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Key hold failed: ${message}` };
    }
}
async function tool_analyze_image(args) {
    const imageInput = String(args.image ?? "");
    const prompt = String(args.prompt ?? "Describe what you see in this image in detail.");
    if (!imageInput) {
        return { success: false, error: "image is required (base64 string or file path)." };
    }
    let base64Image;
    if (imageInput.startsWith("/") ||
        imageInput.startsWith("~") ||
        imageInput.match(/^[a-zA-Z]:[\\/]/)) {
        try {
            const resolvedPath = imageInput.startsWith("~")
                ? path.join(process.env.HOME ?? "", imageInput.slice(1))
                : imageInput;
            const buffer = await fs.readFile(resolvedPath);
            base64Image = buffer.toString("base64");
        }
        catch {
            return { success: false, error: `Could not read image file: ${imageInput}` };
        }
    }
    else {
        base64Image = imageInput;
    }
    const config = vscode.workspace.getConfiguration("localQwen");
    const ollamaUrl = config.get("endpoint", "http://localhost:11434");
    const model = config.get("model", "qwen2.5:32b");
    try {
        const response = await globalFetch(`${ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                prompt,
                images: [base64Image],
                stream: false,
                options: { num_predict: 2048 },
            }),
        });
        if (!response.ok) {
            const sizeKb = Math.round((base64Image.length * 3) / 4 / 1024);
            const fallbackResponse = await globalFetch(`${ollamaUrl}/api/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model,
                    prompt: `An image (${sizeKb}KB PNG) was provided but the model may not support vision. ${prompt}`,
                    stream: false,
                }),
            });
            if (!fallbackResponse.ok) {
                return { success: false, error: `Ollama request failed: ${response.status}` };
            }
            const fallbackData = (await fallbackResponse.json());
            return { success: true, visionSupported: false, analysis: fallbackData.response };
        }
        const data = (await response.json());
        return { success: true, visionSupported: true, analysis: data.response };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Vision request failed: ${message}` };
    }
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GUI Interaction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tool_gui_click(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    const button = String(args.button ?? "left");
    const doubleClick = Boolean(args.doubleClick ?? false);
    if (isNaN(x) || isNaN(y)) {
        return { success: false, error: "x and y coordinates are required." };
    }
    try {
        if (process.platform === "darwin") {
            const clickType = button === "right" ? "rc" : doubleClick ? "dc" : "c";
            await execFileAsync("cliclick", [`${clickType}:${x},${y}`]);
        }
        else {
            const btnNum = button === "right" ? "3" : button === "middle" ? "2" : "1";
            const xdoArgs = ["mousemove", "--sync", String(x), String(y), "click"];
            if (doubleClick) {
                xdoArgs.push("--repeat", "2", "--delay", "100");
            }
            xdoArgs.push(btnNum);
            await execFileAsync("xdotool", xdoArgs);
        }
        return {
            success: true,
            message: `${doubleClick ? "Double-" : ""}${button} clicked at (${x}, ${y}).`,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            error: `Click failed: ${message}. Install cliclick (macOS) or xdotool (Linux).`,
        };
    }
}
async function tool_gui_type(args) {
    const text = String(args.text ?? "");
    const modifiers = args.modifiers ?? [];
    const _delayMs = Number(args.delayMs ?? 50);
    if (!text) {
        return { success: false, error: "text is required." };
    }
    try {
        if (process.platform === "darwin") {
            if (modifiers.length > 0 && text.length === 1) {
                const modMap = {
                    cmd: "cmd",
                    ctrl: "ctrl",
                    alt: "alt",
                    shift: "shift",
                };
                const cliclickMods = modifiers.map((m) => modMap[m] ?? m);
                for (const mod of cliclickMods) {
                    await execFileAsync("cliclick", [`kd:${mod}`]);
                }
                await execFileAsync("cliclick", [`t:${text}`]);
                for (const mod of [...cliclickMods].reverse()) {
                    await execFileAsync("cliclick", [`ku:${mod}`]);
                }
            }
            else {
                await execFileAsync("cliclick", [`t:${text}`]);
            }
        }
        else {
            if (modifiers.length > 0 && text.length === 1) {
                const modMap = {
                    cmd: "super",
                    ctrl: "ctrl",
                    alt: "alt",
                    shift: "shift",
                };
                const combo = [...modifiers.map((m) => modMap[m] ?? m), text].join("+");
                await execFileAsync("xdotool", ["key", combo]);
            }
            else {
                await execFileAsync("xdotool", ["type", "--delay", String(_delayMs), text]);
            }
        }
        return {
            success: true,
            message: `Typed ${text.length} character(s)${modifiers.length > 0 ? ` with ${modifiers.join("+")}` : ""}.`,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            error: `Type failed: ${message}. Install cliclick (macOS) or xdotool (Linux).`,
        };
    }
}
async function tool_gui_scroll(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    const direction = String(args.direction ?? "down");
    const amount = Number(args.amount ?? 3);
    if (isNaN(x) || isNaN(y)) {
        return { success: false, error: "x and y coordinates are required." };
    }
    try {
        if (process.platform === "darwin") {
            await execFileAsync("cliclick", [`m:${x},${y}`]);
            const scrollAmount = direction === "up" ? amount : direction === "down" ? -amount : 0;
            const pyScript = `import Quartz; e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, ${scrollAmount}); Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)`;
            await execFileAsync("python3", ["-c", pyScript]);
        }
        else {
            await execFileAsync("xdotool", ["mousemove", "--sync", String(x), String(y)]);
            const button = direction === "up" ? "4" : direction === "down" ? "5" : direction === "left" ? "6" : "7";
            for (let i = 0; i < amount; i++) {
                await execFileAsync("xdotool", ["click", button]);
            }
        }
        return { success: true, message: `Scrolled ${direction} ${amount} units at (${x}, ${y}).` };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Scroll failed: ${message}` };
    }
}
async function tool_gui_key(args) {
    const key = String(args.key ?? "");
    const modifiers = args.modifiers ?? [];
    if (!key) {
        return { success: false, error: "key is required." };
    }
    try {
        if (process.platform === "darwin") {
            const modMap = {
                cmd: "cmd",
                ctrl: "ctrl",
                alt: "alt",
                shift: "shift",
            };
            const cliclickMods = modifiers.map((m) => modMap[m] ?? m);
            const keyMap = {
                enter: "return",
                return: "return",
                escape: "esc",
                esc: "esc",
                tab: "tab",
                space: "space",
                delete: "delete",
                backspace: "delete",
                up: "arrow-up",
                down: "arrow-down",
                left: "arrow-left",
                right: "arrow-right",
                home: "home",
                end: "end",
                pageup: "page-up",
                pagedown: "page-down",
                f1: "f1",
                f2: "f2",
                f3: "f3",
                f4: "f4",
                f5: "f5",
                f6: "f6",
                f7: "f7",
                f8: "f8",
                f9: "f9",
                f10: "f10",
                f11: "f11",
                f12: "f12",
            };
            for (const mod of cliclickMods) {
                await execFileAsync("cliclick", [`kd:${mod}`]);
            }
            const normalized = key.toLowerCase();
            const mapped = keyMap[normalized];
            if (mapped) {
                await execFileAsync("cliclick", [`kp:${mapped}`]);
            }
            else if (key.length === 1) {
                await execFileAsync("cliclick", [`t:${key}`]);
            }
            else {
                // Best-effort: attempt kp: with the raw key token.
                await execFileAsync("cliclick", [`kp:${normalized}`]);
            }
            for (const mod of [...cliclickMods].reverse()) {
                await execFileAsync("cliclick", [`ku:${mod}`]);
            }
        }
        else {
            const modMap = {
                cmd: "super",
                ctrl: "ctrl",
                alt: "alt",
                shift: "shift",
            };
            const keyMap = {
                enter: "Return",
                return: "Return",
                escape: "Escape",
                esc: "Escape",
                tab: "Tab",
                space: "space",
                delete: "Delete",
                backspace: "BackSpace",
                up: "Up",
                down: "Down",
                left: "Left",
                right: "Right",
            };
            const xdoKey = keyMap[key.toLowerCase()] ?? key;
            const combo = [...modifiers.map((m) => modMap[m] ?? m), xdoKey].join("+");
            await execFileAsync("xdotool", ["key", combo]);
        }
        return {
            success: true,
            message: `Pressed ${modifiers.length > 0 ? modifiers.join("+") + "+" : ""}${key}.`,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Key press failed: ${message}` };
    }
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Window & Process Management
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tool_list_windows(args) {
    const appName = args.appName;
    try {
        if (process.platform === "win32") {
            const escapedFilter = (appName ?? "").replace(/'/g, "''");
            const filterScript = appName
                ? `$filter='${escapedFilter}'.ToLowerInvariant();`
                : "$filter='';";
            const addType = `Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  public static List<Dictionary<string, object>> ListWindows() {
    var results = new List<Dictionary<string, object>>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      var title = sb.ToString();
      if (String.IsNullOrWhiteSpace(title)) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      var entry = new Dictionary<string, object>();
      entry["hwnd"] = hWnd.ToInt64();
      entry["title"] = title;
      entry["pid"] = (int)pid;
      results.Add(entry);
      return true;
    }, IntPtr.Zero);
    return results;
  }
}
'@;`;
            const ps = [
                "$ErrorActionPreference='Stop';",
                addType,
                filterScript,
                "$windows=[WinEnum]::ListWindows();",
                "if ($filter -ne '') { $windows = $windows | Where-Object { ($_.title.ToString()).ToLowerInvariant().Contains($filter) } }",
                "$windows | ConvertTo-Json -Depth 4",
            ].join(" ");
            const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps]);
            const windows = JSON.parse(stdout.trim() || "[]");
            return { success: true, windows };
        }
        if (process.platform === "darwin") {
            // No AppleScript dependency. Full window enumeration requires extra OS-specific tooling.
            // Prefer Swift helper (CGWindowListCopyWindowInfo). Fall back to yabai when installed.
            try {
                const windowsRaw = await listMacWindowsViaSwift();
                const windows = windowsRaw
                    .map((w) => ({
                    app: String(w.app ?? ""),
                    title: String(w.title ?? ""),
                    id: w.id,
                    pid: w.pid,
                    position: w.bounds ? `${w.bounds.x},${w.bounds.y}` : undefined,
                    size: w.bounds ? `${w.bounds.width}x${w.bounds.height}` : undefined,
                }))
                    .filter((w) => !appName || w.app.toLowerCase().includes(appName.toLowerCase()));
                return {
                    success: true,
                    windows,
                    note: "macOS window listing uses a built-in Swift helper (CGWindowListCopyWindowInfo) when available.",
                };
            }
            catch {
                try {
                    const { stdout } = await execFileAsync("yabai", ["-m", "query", "--windows"]);
                    const parsed = JSON.parse(stdout);
                    const windows = parsed
                        .map((w) => ({
                        app: String(w.app ?? ""),
                        title: String(w.title ?? ""),
                        id: w.id,
                        position: w.frame ? `${w.frame.x},${w.frame.y}` : undefined,
                        size: w.frame ? `${w.frame.w}x${w.frame.h}` : undefined,
                    }))
                        .filter((w) => !appName || w.app.toLowerCase().includes(appName.toLowerCase()));
                    return {
                        success: true,
                        windows,
                        note: "macOS window listing uses yabai when installed; Swift helper unavailable.",
                    };
                }
                catch {
                    return {
                        success: true,
                        windows: [],
                        note: "macOS window listing is unavailable (Swift helper failed and yabai not installed). Install Xcode Command Line Tools or yabai.",
                    };
                }
            }
        }
        {
            const { stdout } = await execFileAsync("wmctrl", ["-l", "-G"]);
            const windows = stdout
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                const parts = line.split(/\s+/);
                return {
                    id: parts[0],
                    x: parts[2],
                    y: parts[3],
                    width: parts[4],
                    height: parts[5],
                    app: parts[6],
                    title: parts.slice(7).join(" "),
                };
            })
                .filter((w) => !appName || w.app?.toLowerCase().includes(appName.toLowerCase()));
            return { success: true, windows };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `List windows failed: ${message}` };
    }
}
async function tool_focus_window(args) {
    const windowTitle = String(args.windowTitle ?? "");
    const appName = args.appName;
    if (!windowTitle) {
        return { success: false, error: "windowTitle is required." };
    }
    try {
        if (process.platform === "win32") {
            const escapedTitle = windowTitle.replace(/'/g, "''");
            const addType = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Delegate lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  public static long FocusFirst(string needle) {
    long found = 0;
    EnumWindows((Func<IntPtr, IntPtr, bool>)((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      var title = sb.ToString();
      if (String.IsNullOrWhiteSpace(title)) return true;
      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = hWnd.ToInt64();
        ShowWindow(hWnd, 9); // SW_RESTORE
        SetForegroundWindow(hWnd);
        return false;
      }
      return true;
    }), IntPtr.Zero);
    return found;
  }
}
'@;`;
            const ps = [
                "$ErrorActionPreference='Stop';",
                addType,
                `$h=[WinFocus]::FocusFirst('${escapedTitle}'); if ($h -eq 0) { throw 'No matching window found' } else { $h }`,
            ].join(" ");
            await execFileAsync("powershell", ["-NoProfile", "-Command", ps]);
            return { success: true, message: `Focused window matching "${windowTitle}".` };
        }
        if (process.platform === "darwin") {
            // AppleScript-free best-effort: bring an app to foreground via `open`.
            // If yabai is installed, we can focus by matching window title.
            try {
                const { stdout } = await execFileAsync("yabai", ["-m", "query", "--windows"]);
                const windows = JSON.parse(stdout);
                const match = windows.find((w) => {
                    const title = String(w.title ?? "");
                    const app = String(w.app ?? "");
                    if (appName && !app.toLowerCase().includes(appName.toLowerCase())) {
                        return false;
                    }
                    return title.toLowerCase().includes(windowTitle.toLowerCase());
                });
                if (match?.id) {
                    await execFileAsync("yabai", ["-m", "window", "--focus", String(match.id)]);
                    return { success: true, message: `Focused: ${match.app ?? ""} - ${match.title ?? ""}` };
                }
            }
            catch {
                // ignore and fall back to open -a
            }
            const targetApp = appName || windowTitle;
            await execFileAsync("open", ["-a", targetApp]);
            return {
                success: true,
                message: appName
                    ? `Brought app to foreground: ${appName} (window title focus is best-effort without extra tooling).`
                    : `Brought app to foreground: ${windowTitle} (window title focus is best-effort without extra tooling).`,
            };
        }
        {
            await execFileAsync("wmctrl", ["-a", windowTitle]);
            return { success: true, message: `Focused window matching "${windowTitle}".` };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Focus window failed: ${message}` };
    }
}
async function tool_launch_app(args) {
    const target = String(args.target ?? "");
    const appArgs = args.args ?? [];
    const waitForWindow = args.waitForWindow !== false;
    const timeout = Number(args.timeout ?? 10000);
    if (!target) {
        return { success: false, error: "target is required." };
    }
    try {
        if (process.platform === "darwin") {
            const openArgs = [];
            if (target.startsWith("http://") || target.startsWith("https://")) {
                openArgs.push(target);
            }
            else if (target.includes(".app")) {
                openArgs.push("-a", target);
            }
            else if (target.includes(".")) {
                openArgs.push("-b", target);
            }
            else {
                openArgs.push(target);
            }
            if (appArgs.length > 0) {
                openArgs.push("--args", ...appArgs);
            }
            await execFileAsync("open", openArgs);
        }
        else {
            if (target.startsWith("http://") || target.startsWith("https://")) {
                await execFileAsync("xdg-open", [target]);
            }
            else {
                cp.spawn(target, appArgs, { detached: true, stdio: "ignore" }).unref();
            }
        }
        if (waitForWindow) {
            await new Promise((r) => setTimeout(r, Math.min(timeout, 3000)));
        }
        return {
            success: true,
            message: `Launched: ${target}${appArgs.length > 0 ? ` with args: ${appArgs.join(" ")}` : ""}`,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Launch failed: ${message}` };
    }
}
async function tool_wait_for_condition(args) {
    const type = String(args.type ?? "");
    const target = String(args.target ?? "");
    const timeout = Number(args.timeout ?? 30000);
    const interval = Number(args.interval ?? 1000);
    if (!type) {
        return { success: false, error: "type is required." };
    }
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        let conditionMet = false;
        switch (type) {
            case "file_exists":
                try {
                    await fs.access(target);
                    conditionMet = true;
                }
                catch {
                    conditionMet = false;
                }
                break;
            case "port_open":
                conditionMet = await new Promise((resolve) => {
                    const port = parseInt(target, 10);
                    const socket = new net.Socket();
                    socket.setTimeout(1000);
                    socket
                        .connect(port, "127.0.0.1", () => {
                        socket.destroy();
                        resolve(true);
                    })
                        .on("error", () => {
                        socket.destroy();
                        resolve(false);
                    })
                        .on("timeout", () => {
                        socket.destroy();
                        resolve(false);
                    });
                });
                break;
            case "process_running":
                try {
                    const { stdout } = await execFileAsync("pgrep", ["-f", target]);
                    conditionMet = stdout.trim().length > 0;
                }
                catch {
                    conditionMet = false;
                }
                break;
            case "screen_contains":
                try {
                    // Cross-platform, AppleScript-free: OCR a screenshot and search for target text.
                    const screenshot = (await tool_take_screenshot({ delay: 0 }));
                    if (screenshot?.success && typeof screenshot.image === "string") {
                        const metaOrigin = screenshot?.meta?.origin;
                        const origin = {
                            x: metaOrigin && Number.isFinite(Number(metaOrigin.x)) ? Number(metaOrigin.x) : 0,
                            y: metaOrigin && Number.isFinite(Number(metaOrigin.y)) ? Number(metaOrigin.y) : 0,
                        };
                        const ocr = (await tool_ocr_find_text({
                            image: screenshot.image,
                            query: target,
                            isRegexp: false,
                            maxResults: 1,
                            origin,
                        }));
                        conditionMet = Array.isArray(ocr?.matches) ? ocr.matches.length > 0 : false;
                    }
                }
                catch {
                    conditionMet = false;
                }
                break;
            default:
                return { success: false, error: `Unknown condition type: ${type}` };
        }
        if (conditionMet) {
            return {
                success: true,
                elapsed: Date.now() - startTime,
                message: `Condition "${type}" met for "${target}" after ${Date.now() - startTime}ms.`,
            };
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    return {
        success: false,
        elapsed: Date.now() - startTime,
        error: `Timeout: "${type}" for "${target}" not met within ${timeout}ms.`,
    };
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Diagnostics & Workspace Intelligence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tool_get_diagnostics(args) {
    const filePath = args.filePath;
    const severityFilter = String(args.severity ?? "error");
    const severityMap = {
        error: vscode.DiagnosticSeverity.Error,
        warning: vscode.DiagnosticSeverity.Warning,
        info: vscode.DiagnosticSeverity.Information,
        hint: vscode.DiagnosticSeverity.Hint,
    };
    const minSeverity = severityMap[severityFilter] ?? vscode.DiagnosticSeverity.Error;
    const allDiagnostics = vscode.languages.getDiagnostics();
    const results = [];
    for (const [uri, diagnostics] of allDiagnostics) {
        if (filePath && !uri.fsPath.includes(filePath)) {
            continue;
        }
        for (const diag of diagnostics) {
            if (diag.severity <= minSeverity) {
                results.push({
                    file: uri.fsPath,
                    line: diag.range.start.line + 1,
                    character: diag.range.start.character,
                    severity: Object.entries(severityMap).find(([, v]) => v === diag.severity)?.[0] ?? "unknown",
                    message: diag.message,
                    source: diag.source,
                });
            }
        }
    }
    return {
        totalDiagnostics: results.length,
        diagnostics: results.slice(0, 100),
        hasErrors: results.some((d) => d.severity === "error"),
        summary: results.length === 0 ? "No diagnostics found." : `${results.length} diagnostic(s) found.`,
    };
}
async function tool_get_workspace_symbols(args) {
    const query = String(args.query ?? "");
    const maxResults = Number(args.maxResults ?? 50);
    if (!query) {
        return { success: false, error: "query is required." };
    }
    const symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query);
    if (!symbols || symbols.length === 0) {
        return { success: true, symbols: [], message: `No symbols found matching "${query}".` };
    }
    const results = symbols.slice(0, maxResults).map((sym) => ({
        name: sym.name,
        kind: vscode.SymbolKind[sym.kind],
        file: sym.location.uri.fsPath,
        line: sym.location.range.start.line + 1,
        containerName: sym.containerName || undefined,
    }));
    return { success: true, symbols: results };
}
async function tool_get_document_symbols(args) {
    const filePath = String(args.filePath ?? "");
    if (!filePath) {
        return { success: false, error: "filePath is required." };
    }
    const uri = vscode.Uri.file(filePath);
    try {
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
        if (!symbols || symbols.length === 0) {
            return { success: true, symbols: [], message: "No symbols found in file." };
        }
        function flattenSymbols(syms, depth = 0) {
            const result = [];
            for (const sym of syms) {
                result.push({
                    name: sym.name,
                    kind: vscode.SymbolKind[sym.kind],
                    line: sym.range.start.line + 1,
                    endLine: sym.range.end.line + 1,
                    depth,
                });
                if (sym.children?.length) {
                    result.push(...flattenSymbols(sym.children, depth + 1));
                }
            }
            return result;
        }
        return { success: true, symbols: flattenSymbols(symbols) };
    }
    catch {
        return { success: false, error: `Could not get symbols for ${filePath}.` };
    }
}
async function tool_get_references(args) {
    const filePath = String(args.filePath ?? "");
    const line = Number(args.line ?? 0);
    const character = Number(args.character ?? 0);
    if (!filePath || !line) {
        return { success: false, error: "filePath and line are required." };
    }
    const uri = vscode.Uri.file(filePath);
    const position = new vscode.Position(line - 1, character);
    try {
        const locations = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position);
        if (!locations || locations.length === 0) {
            return { success: true, references: [], message: "No references found." };
        }
        const results = locations.map((loc) => ({
            file: loc.uri.fsPath,
            line: loc.range.start.line + 1,
            character: loc.range.start.character,
        }));
        return { success: true, references: results, count: results.length };
    }
    catch {
        return {
            success: false,
            error: `Could not find references at ${filePath}:${line}:${character}.`,
        };
    }
}
async function tool_get_definition(args) {
    const filePath = String(args.filePath ?? "");
    const line = Number(args.line ?? 0);
    const character = Number(args.character ?? 0);
    if (!filePath || !line) {
        return { success: false, error: "filePath and line are required." };
    }
    const uri = vscode.Uri.file(filePath);
    const position = new vscode.Position(line - 1, character);
    try {
        const locations = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, position);
        if (!locations || locations.length === 0) {
            return { success: true, definitions: [], message: "No definition found." };
        }
        const results = locations.map((loc) => {
            if ("targetUri" in loc) {
                return {
                    file: loc.targetUri.fsPath,
                    line: loc.targetRange.start.line + 1,
                    character: loc.targetRange.start.character,
                };
            }
            return {
                file: loc.uri.fsPath,
                line: loc.range.start.line + 1,
                character: loc.range.start.character,
            };
        });
        return { success: true, definitions: results };
    }
    catch {
        return {
            success: false,
            error: `Could not find definition at ${filePath}:${line}:${character}.`,
        };
    }
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTTP / Network Testing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tool_http_request(args) {
    const url = String(args.url ?? "");
    const method = String(args.method ?? "GET").toUpperCase();
    const headers = args.headers ?? {};
    const body = args.body;
    const timeout = Number(args.timeout ?? 10000);
    const followRedirects = args.followRedirects !== false;
    if (!url) {
        return { success: false, error: "url is required." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await globalFetch(url, {
            method,
            headers,
            signal: controller.signal,
            body: ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
            redirect: followRedirects ? "follow" : "manual",
        });
        clearTimeout(timer);
        const contentType = response.headers.get("content-type") ?? "";
        let responseBody;
        if (contentType.includes("application/json")) {
            const json = await response.json();
            responseBody = JSON.stringify(json, null, 2);
        }
        else {
            responseBody = await response.text();
            if (responseBody.length > 50000) {
                responseBody = responseBody.slice(0, 50000) + "\n...[truncated]";
            }
        }
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });
        return {
            success: true,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody,
        };
    }
    catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `HTTP request failed: ${message}` };
    }
}
let currentAgentState = {
    completed: [],
    remaining: [],
    status: "in_progress",
    lastUpdated: Date.now(),
    turnCount: 0,
};
function getAgentState() {
    return { ...currentAgentState };
}
function resetAgentState() {
    currentAgentState = {
        completed: [],
        remaining: [],
        status: "in_progress",
        lastUpdated: Date.now(),
        turnCount: 0,
    };
}
async function tool_agent_progress(args) {
    const completed = args.completed ?? currentAgentState.completed;
    const remaining = args.remaining ?? currentAgentState.remaining;
    const status = String(args.status ?? "in_progress");
    const blockerDescription = args.blockerDescription;
    const nextAction = args.nextAction;
    currentAgentState = {
        completed,
        remaining,
        status,
        blockerDescription,
        nextAction,
        lastUpdated: Date.now(),
        turnCount: currentAgentState.turnCount + 1,
    };
    const totalItems = completed.length + remaining.length;
    const progressPct = totalItems > 0 ? Math.round((completed.length / totalItems) * 100) : 0;
    return {
        success: true,
        state: currentAgentState,
        progressPercent: progressPct,
        summary: status === "completed"
            ? `All ${completed.length} items complete.`
            : status === "blocked"
                ? `Blocked: ${blockerDescription ?? "unknown reason"}`
                : status === "failed"
                    ? `Failed. Completed ${completed.length}/${totalItems}.`
                    : `${progressPct}% complete (${completed.length}/${totalItems}). Next: ${nextAction ?? "determining..."}`,
    };
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Utility: globalFetch wrapper (use native fetch when available)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function globalFetch(input, init) {
    // Node 18+ has global fetch
    return fetch(input, init);
}
//# sourceMappingURL=handlers.js.map