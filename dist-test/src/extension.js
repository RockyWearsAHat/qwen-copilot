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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const localAgent_1 = require("./agent/localAgent");
const localLanguageModelProvider_1 = require("./llm/localLanguageModelProvider");
const smokeTestRunner_1 = require("./testing/smokeTestRunner");
const toolRegistry_1 = require("./tools/toolRegistry");
function activate(context) {
    const output = vscode.window.createOutputChannel("Local Qwen Agent");
    const registry = new toolRegistry_1.ToolRegistry(output);
    const runner = new localAgent_1.LocalAgentRunner(registry, output);
    const modelProvider = new localLanguageModelProvider_1.LocalLanguageModelProvider(output);
    const smokeTests = new smokeTestRunner_1.SmokeTestRunner(output);
    const participant = vscode.chat.createChatParticipant("localQwen.agent", async (request, _chatContext, stream, token) => {
        await runner.handleRequest(request, stream, token);
    });
    participant.iconPath = new vscode.ThemeIcon("hubot");
    const refreshCommand = vscode.commands.registerCommand("localQwen.refreshTools", async () => {
        await registry.refresh();
        const tools = registry.getExecutableTools();
        vscode.window.showInformationMessage(`Local Qwen Agent discovered ${tools.length} executable tools.`);
    });
    const providerRegistration = vscode.lm.registerLanguageModelChatProvider("local-ollama", modelProvider);
    const runSmokeTestCommand = vscode.commands.registerCommand("localQwen.runSmokeTest", async () => {
        try {
            output.show(true);
            output.appendLine("[local-qwen] running smoke test...");
            const result = await smokeTests.run();
            output.appendLine(`[local-qwen] smoke-test response: ${result.responsePreview}`);
            vscode.window.showInformationMessage(`Smoke test passed with model '${result.modelUsed}'.`);
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            output.appendLine(`[local-qwen] smoke-test failed: ${text}`);
            vscode.window.showErrorMessage(`Local Qwen smoke test failed: ${text}`);
        }
    });
    const listLocalModelsCommand = vscode.commands.registerCommand("localQwen.listLocalModels", async () => {
        try {
            const modelNames = await smokeTests.listModels();
            if (modelNames.length === 0) {
                vscode.window.showWarningMessage("No local Ollama models discovered at the configured endpoint.");
                return;
            }
            output.appendLine(`[local-qwen] discovered local models: ${modelNames.join(", ")}`);
            vscode.window.showInformationMessage(`Local models: ${modelNames.join(", ")}`);
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            output.appendLine(`[local-qwen] list models failed: ${text}`);
            vscode.window.showErrorMessage(`Unable to list local models: ${text}`);
        }
    });
    context.subscriptions.push(output, participant, refreshCommand, providerRegistration, runSmokeTestCommand, listLocalModelsCommand);
}
function deactivate() {
    // no-op
}
//# sourceMappingURL=extension.js.map