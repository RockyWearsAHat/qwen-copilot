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
exports.isOutboundLoggingEnabled = isOutboundLoggingEnabled;
exports.getOutboundLogFilePath = getOutboundLogFilePath;
exports.appendOutboundOllamaRequestLog = appendOutboundOllamaRequestLog;
const vscode = __importStar(require("vscode"));
const promises_1 = require("fs/promises");
const path = __importStar(require("path"));
function getWorkspaceRoot() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root?.trim() ? root : undefined;
}
function resolveLogPath(configuredPath) {
    const trimmed = configuredPath.trim();
    if (!trimmed) {
        return undefined;
    }
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }
    const root = getWorkspaceRoot();
    if (!root) {
        return undefined;
    }
    return path.join(root, trimmed);
}
function isOutboundLoggingEnabled() {
    return vscode.workspace.getConfiguration("localQwen").get("outboundLogEnabled", false);
}
function getOutboundLogFilePath() {
    const configured = vscode.workspace
        .getConfiguration("localQwen")
        .get("outboundLogFile", "local-qwen-ollama-outbound.jsonl");
    return resolveLogPath(configured);
}
function getOutboundLatestFilePath() {
    const jsonl = getOutboundLogFilePath();
    if (!jsonl)
        return undefined;
    const dir = path.dirname(jsonl);
    const base = path.basename(jsonl);
    // local-qwen-ollama-outbound.jsonl -> local-qwen-ollama-outbound.latest.json
    const latestName = base.endsWith(".jsonl")
        ? base.replace(/\.jsonl$/i, ".latest.json")
        : `${base}.latest.json`;
    return path.join(dir, latestName);
}
async function appendOutboundOllamaRequestLog(params) {
    if (!isOutboundLoggingEnabled()) {
        return;
    }
    const filePath = getOutboundLogFilePath();
    if (!filePath) {
        return;
    }
    const entry = {
        timestamp: new Date().toISOString(),
        source: params.source,
        request: params.request,
    };
    try {
        await (0, promises_1.appendFile)(filePath, `${JSON.stringify(entry)}\n`, "utf8");
        const latestPath = getOutboundLatestFilePath();
        if (latestPath) {
            await (0, promises_1.mkdir)(path.dirname(latestPath), { recursive: true });
            await (0, promises_1.writeFile)(latestPath, JSON.stringify(entry, null, 2), "utf8");
        }
    }
    catch {
        // best-effort only
        params.output.appendLine("[local-qwen] outbound log write failed (ignored)");
    }
}
//# sourceMappingURL=outboundLogger.js.map