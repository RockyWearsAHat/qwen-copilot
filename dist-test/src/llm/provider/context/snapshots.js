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
exports.buildCompletionChecklistSnapshot = buildCompletionChecklistSnapshot;
exports.buildWorkspaceContextSnapshot = buildWorkspaceContextSnapshot;
const vscode = __importStar(require("vscode"));
const promises_1 = require("node:fs/promises");
const nodePath = __importStar(require("node:path"));
const node_fs_1 = require("node:fs");
/** Directories to always skip when building the workspace file tree. */
const TREE_SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "dist-test",
    ".vscode",
    ".cache",
    "coverage",
    ".coverage",
    "__pycache__",
    ".next",
    ".nuxt",
    "out",
]);
/**
 * Builds an indented file tree string for the workspace, e.g.:
 *   src/
 *     game.ts
 *     platformerGame.ts
 *   assets/             ← Vite publicDir: served at web root "/"
 *     PNG/              ← served at "/PNG/"
 *       explosion.png
 *
 * Caps output to avoid bloating the context window.
 */
async function buildFileTree(workspaceRoot, vitePublicDir, maxFiles = 400) {
    const lines = [];
    let count = 0;
    async function walk(dir, indent) {
        if (count >= maxFiles)
            return;
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir, { withFileTypes: true, encoding: "utf8" });
        }
        catch {
            return;
        }
        // Dirs first, then files, both sorted
        const dirs = entries
            .filter((e) => e.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name));
        const files = entries
            .filter((e) => !e.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of [...dirs, ...files]) {
            if (count >= maxFiles) {
                lines.push(`${indent}… (truncated)`);
                return;
            }
            if (entry.isDirectory()) {
                if (TREE_SKIP_DIRS.has(entry.name))
                    continue;
                const relFromRoot = nodePath
                    .relative(workspaceRoot, nodePath.join(dir, entry.name))
                    .replace(/\\/g, "/");
                let annotation = "";
                if (vitePublicDir && relFromRoot === vitePublicDir) {
                    annotation = `  ← Vite publicDir: served at web root "/"`;
                }
                else if (vitePublicDir) {
                    const pubRel = nodePath
                        .relative(nodePath.join(workspaceRoot, vitePublicDir), nodePath.join(dir, entry.name))
                        .replace(/\\/g, "/");
                    if (!pubRel.startsWith("..")) {
                        annotation = `  ← served at "/${pubRel}/"`;
                    }
                }
                lines.push(`${indent}${entry.name}/${annotation}`);
                count++;
                await walk(nodePath.join(dir, entry.name), indent + "  ");
            }
            else {
                lines.push(`${indent}${entry.name}`);
                count++;
            }
        }
    }
    await walk(workspaceRoot, "");
    return lines.join("\n");
}
/**
 * Reads the workspace's Vite config (if present) and returns the configured
 * publicDir value, or null if this is not a Vite project.
 */
async function detectVitePublicDir(workspaceRoot) {
    for (const cfg of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
        try {
            const src = await (0, promises_1.readFile)(nodePath.join(workspaceRoot, cfg), "utf8");
            const m = src.match(/publicDir\s*:\s*['"]([^'"]+)['"]/);
            if (m)
                return m[1];
            // Vite present but no explicit publicDir — check which candidate dir exists
            for (const candidate of ["public", "assets", "static"]) {
                if ((0, node_fs_1.existsSync)(nodePath.join(workspaceRoot, candidate)))
                    return candidate;
            }
            return "public";
        }
        catch {
            // config file absent — try next
        }
    }
    return null;
}
/** Builds the completion checklist system message payload. */
async function buildCompletionChecklistSnapshot() {
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return "";
        }
        const relPath = ".github/completion-checklist.md";
        const absPath = nodePath.join(workspaceRoot, relPath);
        let raw = "";
        try {
            raw = await (0, promises_1.readFile)(absPath, "utf8");
        }
        catch {
            // File doesn't exist — return empty so we don't inject noise into real requests.
            return "";
        }
        const normalized = raw.replace(/\r\n/g, "\n").trim();
        const maxChars = 12000;
        const clipped = normalized.length > maxChars
            ? `${normalized.slice(0, maxChars).trimEnd()}\n\n...\n\n(Truncated to ${maxChars} chars)`
            : normalized;
        if (!clipped) {
            return "";
        }
        return [
            "## Completion Checklist (auto-injected — hard gate)",
            `**source:** ${relPath}`,
            "**rule:** Do NOT claim completion until every checklist item is satisfied (or explicitly justified as not applicable).",
            "",
            clipped,
        ].join("\n");
    }
    catch {
        return "";
    }
}
/** Builds a compact workspace context snapshot to prepend to every LLM request. */
async function buildWorkspaceContextSnapshot() {
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return "";
        }
        const snapshotTimestamp = new Date().toISOString();
        const lines = [
            "## Workspace Context — LIVE SNAPSHOT (auto-injected, rebuilt each request)",
            `**Generated at:** ${snapshotTimestamp}`,
            `**Workspace root on disk:** \`${workspaceRoot}\``,
            `**All tool calls that take a file path require an absolute path. Prepend the workspace root above to any relative path in this snapshot.**`,
            `  Example: to read \`src/game.ts\`, use path \`${workspaceRoot}/src/game.ts\``,
            "",
            `**How this snapshot was built:** The extension recursively walked every directory under \`${workspaceRoot}\` (equivalent to \`find ${workspaceRoot} -type f\` or calling list_dir on every folder). The result is the complete file tree below.`,
            "**This snapshot supersedes the <workspace_info> block above**, which may be truncated and only shows directories. The tree below shows every file.",
            "For a broken import or asset reference: check the file tree below — do not call find, ls, or list_dir to rediscover what is already listed here.",
        ];
        // --- package.json -------------------------------------------------------
        try {
            const pkgRaw = await (0, promises_1.readFile)(nodePath.join(workspaceRoot, "package.json"), "utf8");
            const pkg = JSON.parse(pkgRaw);
            const allDeps = {
                ...(pkg.dependencies ?? {}),
                ...(pkg.devDependencies ?? {}),
            };
            const toolchainKeys = Object.keys(allDeps).filter((k) => /vite|webpack|rollup|parcel|esbuild|tsc\b|tsx\b|turbo/i.test(k));
            const scriptNames = Object.keys(pkg.scripts ?? {});
            lines.push(`**project:** ${String(pkg.name ?? "unknown")}` +
                (toolchainKeys.length ? ` | **build tools:** ${toolchainKeys.join(", ")}` : "") +
                (scriptNames.length ? ` | **scripts:** ${scriptNames.join(", ")}` : ""));
        }
        catch {
            // package.json absent or malformed — skip
        }
        // --- Config files -------------------------------------------------------
        const configCandidates = [
            "vite.config.ts",
            "vite.config.js",
            "vite.config.mts",
            "vite.config.mjs",
            "webpack.config.js",
            "webpack.config.ts",
            "tsconfig.json",
            "tsconfig.app.json",
        ];
        const foundConfigs = [];
        for (const cf of configCandidates) {
            try {
                await (0, promises_1.readFile)(nodePath.join(workspaceRoot, cf), "utf8");
                foundConfigs.push(cf);
            }
            catch {
                // absent
            }
        }
        if (foundConfigs.length) {
            lines.push(`**config files:** ${foundConfigs.join(", ")}`);
        }
        // --- Vite config (raw content) + publicDir semantics --------------------
        const vitePublicDir = await detectVitePublicDir(workspaceRoot);
        for (const cfg of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
            try {
                const cfgContent = await (0, promises_1.readFile)(nodePath.join(workspaceRoot, cfg), "utf8");
                lines.push(`**${cfg}:**\n\`\`\`\n${cfgContent.trim()}\n\`\`\``);
                break;
            }
            catch {
                /* absent */
            }
        }
        if (vitePublicDir) {
            lines.push(`**Vite publicDir = "${vitePublicDir}"** — PATH RULE (critical):`, `  • The \`${vitePublicDir}/\` folder on disk is the browser's web root \`/\`.`, `  • Strip "${vitePublicDir}/" from any disk path to get the URL path used in code.`, `  • Example: disk \`${vitePublicDir}/PNG/explosion.png\` → code \`"/PNG/explosion.png"\``, `  • ✅ CORRECT in code: \`"/PNG/explosion.png"\``, `  • ❌ WRONG in code:  \`"${vitePublicDir}/PNG/explosion.png"\` — do NOT include "${vitePublicDir}/" as a prefix in any path string written in source files.`);
        }
        // --- Open editor file contents ------------------------------------------
        // Inject the content of currently visible editors upfront so the model
        // never needs a read_file tool call for files the user already has open.
        // This mirrors what the real Copilot agent does automatically.
        const maxOpenFileChars = 12000;
        const maxOpenFiles = 6;
        const injectedPaths = new Set();
        const openEditorLines = [];
        const collectEditor = (editor) => {
            if (openEditorLines.length >= maxOpenFiles)
                return;
            const uri = editor.document.uri;
            if (uri.scheme !== "file")
                return;
            const absPath = uri.fsPath;
            if (injectedPaths.has(absPath))
                return;
            const relPath = nodePath.relative(workspaceRoot, absPath).replace(/\\/g, "/");
            if (relPath.startsWith(".."))
                return; // outside workspace
            injectedPaths.add(absPath);
            const fullText = editor.document.getText();
            const truncated = fullText.length > maxOpenFileChars
                ? fullText.slice(0, maxOpenFileChars) + `\n… (truncated at ${maxOpenFileChars} chars)`
                : fullText;
            openEditorLines.push(`**Currently open file: \`${relPath}\`** (full content — no read_file call needed for this file):\n\`\`\`\n${truncated}\n\`\`\``);
        };
        // Active editor first (most relevant), then other visible editors
        const active = vscode.window.activeTextEditor;
        if (active)
            collectEditor(active);
        for (const editor of vscode.window.visibleTextEditors) {
            if (openEditorLines.length >= maxOpenFiles)
                break;
            collectEditor(editor);
        }
        if (openEditorLines.length > 0) {
            lines.push("## Open Editor Contents (pre-loaded — do NOT call read_file for these files)", ...openEditorLines);
        }
        // --- Full workspace file tree -------------------------------------------
        // Annotated with Vite publicDir serving paths inline so the model knows
        // exactly where each file lives and what URL path it maps to.
        const tree = await buildFileTree(workspaceRoot, vitePublicDir);
        if (tree) {
            lines.push(`**Complete workspace file tree** (produced by recursively listing every directory under \`${workspaceRoot}\` — this IS the output of list_dir on every folder, already done for you):\n\`\`\`\n${tree}\n\`\`\``, `--- End of file tree. This is the result of recursively walking \`${workspaceRoot}\`. Calling list_dir or find would return the same data. If a file is not listed above, it does not exist. ---`);
        }
        return lines.length > 1 ? lines.join("\n") : "";
    }
    catch {
        return "";
    }
}
//# sourceMappingURL=snapshots.js.map