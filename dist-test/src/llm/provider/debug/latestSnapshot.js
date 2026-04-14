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
exports.isLatestDebugSnapshotEnabled = isLatestDebugSnapshotEnabled;
exports.getLatestDebugSnapshotPath = getLatestDebugSnapshotPath;
exports.writeLatestDebugSnapshot = writeLatestDebugSnapshot;
const vscode = __importStar(require("vscode"));
const promises_1 = require("node:fs/promises");
const path = __importStar(require("node:path"));
function getWorkspaceRoot() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root?.trim() ? root : undefined;
}
function resolveWorkspacePath(relOrAbs) {
    const trimmed = relOrAbs.trim();
    if (!trimmed)
        return undefined;
    if (path.isAbsolute(trimmed))
        return trimmed;
    const root = getWorkspaceRoot();
    if (!root)
        return undefined;
    return path.join(root, trimmed);
}
function isLatestDebugSnapshotEnabled() {
    return vscode.workspace
        .getConfiguration("localQwen")
        .get("latestDebugSnapshotEnabled", true);
}
function getLatestDebugSnapshotPath() {
    const configured = vscode.workspace
        .getConfiguration("localQwen")
        .get("latestDebugSnapshotFile", ".local-qwen/latest-debug-snapshot.json");
    return resolveWorkspacePath(configured);
}
function safeTruncateJson(value, maxChars) {
    try {
        const raw = JSON.stringify(value);
        if (raw.length <= maxChars)
            return value;
        return {
            truncated: true,
            maxChars,
            preview: raw.slice(0, maxChars),
        };
    }
    catch {
        return { truncated: true, maxChars, preview: String(value).slice(0, maxChars) };
    }
}
/**
 * Best-effort writer for a single, overwrite-in-place snapshot.
 * Intended for humans + the agent to inspect the latest run without stale log buildup.
 */
async function writeLatestDebugSnapshot(params) {
    if (!isLatestDebugSnapshotEnabled())
        return;
    const filePath = getLatestDebugSnapshotPath();
    if (!filePath)
        return;
    const snapshot = {
        generatedAt: new Date().toISOString(),
        source: params.source,
        platform: process.platform,
        // Keep this compact to avoid accidentally dumping huge payloads.
        data: safeTruncateJson(params.data, 120000),
    };
    try {
        await (0, promises_1.mkdir)(path.dirname(filePath), { recursive: true });
        await (0, promises_1.writeFile)(filePath, JSON.stringify(snapshot, null, 2), "utf8");
    }
    catch {
        params.output?.appendLine?.("[local-qwen] latest debug snapshot write failed (ignored)");
    }
}
//# sourceMappingURL=latestSnapshot.js.map