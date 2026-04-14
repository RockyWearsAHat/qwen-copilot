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
const path = __importStar(require("node:path"));
const handlers_1 = require("../../src/tools/handlers");
suite("GUI tool contracts", () => {
    test("tool_focus_window validates required args", async () => {
        const result = (await (0, handlers_1.tool_focus_window)({}));
        strict_1.default.equal(result.success, false);
        strict_1.default.ok(String(result.error).toLowerCase().includes("windowtitle is required"));
    });
    test("GUI tools fail fast with missing backends (PATH cleared)", async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = "";
        try {
            const typeRes = (await (0, handlers_1.tool_gui_type)({ text: "x" }));
            strict_1.default.equal(typeRes.success, false);
            strict_1.default.ok(String(typeRes.error).includes("Type failed"));
            const keyRes = (await (0, handlers_1.tool_gui_key)({ key: "enter" }));
            // tool_gui_key uses a generic failure message (no install hint) – just assert contract.
            strict_1.default.equal(keyRes.success, false);
            strict_1.default.ok(String(keyRes.error).includes("Key press failed"));
            const clickRes = (await (0, handlers_1.tool_gui_click)({ x: 10, y: 10 }));
            strict_1.default.equal(clickRes.success, false);
            strict_1.default.ok(String(clickRes.error).includes("Click failed"));
        }
        finally {
            process.env.PATH = originalPath;
        }
    });
    test("tool_take_screenshot returns structured failure when capture backend is unavailable", async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = "";
        try {
            const res = (await (0, handlers_1.tool_take_screenshot)({}));
            strict_1.default.equal(res.success, false);
            strict_1.default.ok(String(res.error).includes("Screenshot failed"));
        }
        finally {
            process.env.PATH = originalPath;
        }
    });
    test("tool_list_windows returns a stable object shape", async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = "";
        try {
            const res = (await (0, handlers_1.tool_list_windows)({}));
            // On macOS without yabai: success true with empty list + note.
            // On Linux without wmctrl: success false with an error.
            // On Windows without powershell in PATH: success false.
            strict_1.default.ok(typeof res === "object" && res);
            strict_1.default.ok("success" in res);
            if (res.success === true) {
                strict_1.default.ok(Array.isArray(res.windows));
            }
            else {
                strict_1.default.ok(typeof res.error === "string");
            }
        }
        finally {
            process.env.PATH = originalPath;
        }
    });
});
suite("No osascript regression", () => {
    test("src/ contains no osascript invocation or references", async () => {
        const repoRoot = path.resolve(__dirname, "..", "..", "..");
        const srcRoot = path.join(repoRoot, "src");
        const files = [];
        const walk = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                }
                else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
                    files.push(full);
                }
            }
        };
        await walk(srcRoot);
        const offenders = [];
        for (const file of files) {
            const content = await fs.readFile(file, "utf8");
            const matches = content.match(/\bosascript\b/gi);
            if (matches && matches.length > 0) {
                offenders.push({ file, count: matches.length });
            }
        }
        strict_1.default.deepEqual(offenders, []);
    });
});
//# sourceMappingURL=guiTools.contract.test.js.map