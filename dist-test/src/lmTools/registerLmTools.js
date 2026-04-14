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
exports.registerLanguageModelTools = registerLanguageModelTools;
const vscode = __importStar(require("vscode"));
const handlers_1 = require("../tools/handlers");
function asJsonResult(value) {
    return new vscode.LanguageModelToolResult([vscode.LanguageModelDataPart.json(value)]);
}
function asTextResult(text) {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
function requireConfirmation(title, body) {
    return {
        confirmationMessages: {
            title,
            message: new vscode.MarkdownString(body),
        },
    };
}
function registerLanguageModelTools(context, output) {
    const tools = [];
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const machineToolsEnabled = configuration.get("enableMachineInteractionTools", false);
    const machineToolsDisabledResult = (toolId) => asJsonResult({
        success: false,
        error: `Tool '${toolId}' is disabled. Enable localQwen.enableMachineInteractionTools to allow screenshot/OCR/GUI interaction tools.`,
    });
    tools.push(vscode.lm.registerTool("localQwen_take_screenshot", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            const details = [
                typed.windowTitle ? `windowTitle=\"${typed.windowTitle}\"` : "full screen",
                typed.region ? "region=…" : "",
                typeof typed.delay === "number" && typed.delay > 0 ? `delay=${typed.delay}s` : "",
            ]
                .filter(Boolean)
                .join(", ");
            return { invocationMessage: `Capturing screenshot (${details})…` };
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_take_screenshot");
            }
            const result = (await (0, handlers_1.tool_take_screenshot)(input));
            if (!result?.success || !result?.image) {
                return asJsonResult(result);
            }
            const buffer = Buffer.from(String(result.image), "base64");
            const meta = {
                format: result.format,
                sizeBytes: result.sizeBytes,
                meta: result.meta,
            };
            return new vscode.LanguageModelToolResult([
                vscode.LanguageModelDataPart.image(new Uint8Array(buffer), "image/png"),
                vscode.LanguageModelDataPart.json(meta),
            ]);
        },
    }));
    if (!machineToolsEnabled) {
        output.appendLine("[local-qwen] machine interaction tools are disabled (localQwen.enableMachineInteractionTools=false); machine LM tools are registered but will return a disabled error until enabled.");
    }
    tools.push(vscode.lm.registerTool("localQwen_analyze_image", {
        prepareInvocation: () => ({ invocationMessage: "Analyzing image…" }),
        invoke: async ({ input }) => {
            const result = await (0, handlers_1.tool_analyze_image)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_ocr_find_text", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            return { invocationMessage: `Running OCR for: ${typed.query ?? "(unknown)"}` };
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_ocr_find_text");
            }
            const result = await (0, handlers_1.tool_ocr_find_text)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_list_windows", {
        prepareInvocation: () => ({ invocationMessage: "Listing windows…" }),
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_list_windows");
            }
            const result = await (0, handlers_1.tool_list_windows)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_focus_window", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            return requireConfirmation("Focus window", `Bring a window matching **${typed.windowTitle ?? "(unknown)"}** to the foreground?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_focus_window");
            }
            const result = await (0, handlers_1.tool_focus_window)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_launch_app", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            const args = Array.isArray(typed.args) && typed.args.length > 0 ? ` ${typed.args.join(" ")}` : "";
            return requireConfirmation("Launch app or URL", `Launch **${typed.target ?? "(unknown)"}**${args}?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_launch_app");
            }
            const result = await (0, handlers_1.tool_launch_app)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_gui_click", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            return requireConfirmation("GUI click", `Click at (**${typed.x ?? "?"}**, **${typed.y ?? "?"}**) with **${typed.button ?? "left"}**${typed.doubleClick ? " (double)" : ""}?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_gui_click");
            }
            const result = await (0, handlers_1.tool_gui_click)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_gui_type", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            const preview = (typed.text ?? "").slice(0, 80);
            return requireConfirmation("GUI type", `Type: \`${preview}\`${(typed.text ?? "").length > 80 ? "…" : ""}?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_gui_type");
            }
            const result = await (0, handlers_1.tool_gui_type)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_gui_scroll", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            return requireConfirmation("GUI scroll", `Scroll **${typed.direction ?? "down"}** at (**${typed.x ?? "?"}**, **${typed.y ?? "?"}**) amount=${typed.amount ?? 3}?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_gui_scroll");
            }
            const result = await (0, handlers_1.tool_gui_scroll)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_gui_key", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            const combo = `${Array.isArray(typed.modifiers) && typed.modifiers.length > 0 ? typed.modifiers.join("+") + "+" : ""}${typed.key ?? ""}`;
            return requireConfirmation("GUI key press", `Press **${combo || "(unknown)"}**?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_gui_key");
            }
            const result = await (0, handlers_1.tool_gui_key)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_gui_key_hold", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            return requireConfirmation("GUI key hold", `Hold **${typed.key ?? "(unknown)"}** for **${typed.durationMs ?? 300}ms**?`);
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_gui_key_hold");
            }
            const result = await (0, handlers_1.tool_gui_key_hold)(input);
            return asJsonResult(result);
        },
    }));
    tools.push(vscode.lm.registerTool("localQwen_wait_for_condition", {
        prepareInvocation: ({ input }) => {
            const typed = input;
            return { invocationMessage: `Waiting for condition: ${typed.type ?? "(unknown)"}` };
        },
        invoke: async ({ input }) => {
            const latestEnabled = vscode.workspace
                .getConfiguration("localQwen")
                .get("enableMachineInteractionTools", false);
            if (!latestEnabled) {
                return machineToolsDisabledResult("localQwen_wait_for_condition");
            }
            const result = await (0, handlers_1.tool_wait_for_condition)(input);
            return asJsonResult(result);
        },
    }));
    for (const disposable of tools) {
        context.subscriptions.push(disposable);
    }
    output.appendLine(`[local-qwen] registered ${tools.length} language-model tools.`);
}
//# sourceMappingURL=registerLmTools.js.map