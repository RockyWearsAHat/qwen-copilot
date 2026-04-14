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
const latestSnapshot_1 = require("../../src/llm/provider/debug/latestSnapshot");
suite("Latest debug snapshot", () => {
    test("writes a single overwrite-in-place snapshot file", async () => {
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-snapshot-"));
        const snapshotRel = ".local-qwen/latest-debug-snapshot.json";
        const snapshotPath = path.join(tmpRoot, snapshotRel);
        const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
            configurable: true,
            value: [{ uri: vscode.Uri.file(tmpRoot) }],
        });
        Object.defineProperty(vscode.workspace, "getConfiguration", {
            configurable: true,
            value: () => ({
                get: (key, fallback) => {
                    if (key === "latestDebugSnapshotEnabled")
                        return true;
                    if (key === "latestDebugSnapshotFile")
                        return snapshotRel;
                    return fallback;
                },
            }),
        });
        try {
            await (0, latestSnapshot_1.writeLatestDebugSnapshot)({ source: "participant", data: { n: 1 } });
            const first = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
            strict_1.default.equal(first.source, "participant");
            strict_1.default.equal(first.data.n, 1);
            await (0, latestSnapshot_1.writeLatestDebugSnapshot)({ source: "participant", data: { n: 2 } });
            const second = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
            strict_1.default.equal(second.data.n, 2);
        }
        finally {
            Object.defineProperty(vscode.workspace, "workspaceFolders", {
                configurable: true,
                value: originalWorkspaceFolders,
            });
            Object.defineProperty(vscode.workspace, "getConfiguration", {
                configurable: true,
                value: originalGetConfiguration,
            });
        }
    });
});
//# sourceMappingURL=latestSnapshot.test.js.map