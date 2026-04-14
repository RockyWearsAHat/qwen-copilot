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
const vscode = __importStar(require("vscode"));
const toolRegistry_1 = require("../../src/tools/toolRegistry");
const MACHINE_TOOLS = [
    "take_screenshot",
    "ocr_find_text",
    "list_windows",
    "focus_window",
    "launch_app",
    "gui_click",
    "gui_type",
    "gui_scroll",
    "gui_key",
    "gui_key_hold",
    "wait_for_condition",
];
suite("Machine interaction tools opt-in", () => {
    test("are always listed, but execution is blocked unless enableMachineInteractionTools=true", async () => {
        const output = vscode.window.createOutputChannel("local-qwen optin test");
        const registry = new toolRegistry_1.ToolRegistry(output);
        const config = vscode.workspace.getConfiguration("localQwen");
        const original = config.get("enableMachineInteractionTools", false);
        try {
            await config.update("enableMachineInteractionTools", false, vscode.ConfigurationTarget.Workspace);
            await registry.refresh();
            const disabledNames = registry.getExecutableTools().map((t) => t.name);
            for (const name of MACHINE_TOOLS) {
                strict_1.default.equal(disabledNames.includes(name), true, `Expected '${name}' to be listed even when disabled`);
            }
            // Execution is blocked with a visible error.
            const disabledExec = (await registry.execute("take_screenshot", {}));
            strict_1.default.equal(disabledExec.success, false);
            strict_1.default.ok(String(disabledExec.error).includes("enableMachineInteractionTools"));
            await config.update("enableMachineInteractionTools", true, vscode.ConfigurationTarget.Workspace);
            const enabledNames = registry.getExecutableTools().map((t) => t.name);
            // Still listed.
            strict_1.default.ok(enabledNames.includes("take_screenshot"));
            strict_1.default.ok(enabledNames.includes("gui_click"));
        }
        finally {
            await config.update("enableMachineInteractionTools", original, vscode.ConfigurationTarget.Workspace);
            output.dispose();
        }
    });
});
//# sourceMappingURL=machineInteractionOptIn.test.js.map