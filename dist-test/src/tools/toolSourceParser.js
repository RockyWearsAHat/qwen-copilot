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
exports.ToolSourceParser = void 0;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const toolNameExtraction_1 = require("./toolNameExtraction");
const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json"]);
class ToolSourceParser {
    output;
    constructor(output) {
        this.output = output;
    }
    async discoverToolNames() {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const roots = await this.getDiscoveryRoots(configuration.get("toolDiscoveryRoots", []));
        const maxFiles = configuration.get("maxToolSourceFiles", 1500);
        const maxBytes = configuration.get("maxToolSourceBytes", 300000);
        const discovered = new Set();
        let scannedFiles = 0;
        for (const root of roots) {
            const files = await this.walk(root, maxFiles - scannedFiles);
            for (const filePath of files) {
                if (scannedFiles >= maxFiles) {
                    break;
                }
                scannedFiles += 1;
                let stat;
                try {
                    stat = await fs.stat(filePath);
                }
                catch {
                    continue;
                }
                if (stat.size > maxBytes) {
                    continue;
                }
                const content = await fs.readFile(filePath, "utf8");
                const names = (0, toolNameExtraction_1.extractToolNamesFromSource)(content);
                for (const name of names) {
                    discovered.add(name);
                }
            }
            if (scannedFiles >= maxFiles) {
                break;
            }
        }
        this.output.appendLine(`[local-qwen] Discovered ${discovered.size} tool names from ${scannedFiles} source files.`);
        return discovered;
    }
    async getDiscoveryRoots(extraRoots) {
        const roots = new Set();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            roots.add(folder.uri.fsPath);
        }
        for (const root of extraRoots) {
            if (root && path.isAbsolute(root)) {
                roots.add(root);
            }
        }
        const copilotChat = vscode.extensions.getExtension("GitHub.copilot-chat") ??
            vscode.extensions.getExtension("github.copilot-chat");
        if (copilotChat?.extensionPath) {
            roots.add(copilotChat.extensionPath);
        }
        return [...roots];
    }
    async walk(root, budget) {
        const results = [];
        if (budget <= 0) {
            return results;
        }
        const stack = [root];
        while (stack.length > 0 && results.length < budget) {
            const current = stack.pop();
            if (!current) {
                continue;
            }
            let entries;
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (results.length >= budget) {
                    break;
                }
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === "node_modules" || entry.name.startsWith(".git")) {
                        continue;
                    }
                    stack.push(fullPath);
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                const extension = path.extname(entry.name).toLowerCase();
                if (SUPPORTED_EXTENSIONS.has(extension)) {
                    results.push(fullPath);
                }
            }
        }
        return results;
    }
}
exports.ToolSourceParser = ToolSourceParser;
//# sourceMappingURL=toolSourceParser.js.map