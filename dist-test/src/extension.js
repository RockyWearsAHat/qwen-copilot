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
    output.appendLine("[local-qwen] extension activated");
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
    output.appendLine("[local-qwen] startup auto-pinning of Copilot agent model settings is disabled.");
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
    const verifyProviderCommand = vscode.commands.registerCommand("localQwen.verifyModelProvider", async () => {
        try {
            const models = await vscode.lm.selectChatModels({
                vendor: "local-ollama",
            });
            const names = models.map((model) => `${model.name} (${model.id})`);
            output.appendLine(`[local-qwen] provider verification: ${models.length} model(s) from vendor local-ollama`);
            if (names.length > 0) {
                output.appendLine(`[local-qwen] provider models: ${names.join(", ")}`);
                vscode.window.showInformationMessage(`Provider registered: ${models.length} local-ollama model(s) visible to VS Code LM API.`);
            }
            else {
                vscode.window.showWarningMessage("No local-ollama models were returned by VS Code LM API. Check Extension Host activation and endpoint/model config.");
            }
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            output.appendLine(`[local-qwen] provider verification failed: ${text}`);
            vscode.window.showErrorMessage(`Provider verification failed: ${text}`);
        }
    });
    context.subscriptions.push(output, participant, refreshCommand, providerRegistration, runSmokeTestCommand, listLocalModelsCommand, verifyProviderCommand);
}
function deactivate() {
    // no-op
}
async function pinCopilotAgentModelsToLocal(output) {
    try {
        const localConfiguration = vscode.workspace.getConfiguration("localQwen");
        const preferredModel = localConfiguration.get("model", "");
        const localModels = await vscode.lm.selectChatModels({
            vendor: "local-ollama",
        });
        if (localModels.length === 0) {
            output.appendLine("[local-qwen] no local models found to pin Copilot agent model settings.");
            return;
        }
        const picked = localModels.find((model) => model.id === preferredModel ||
            model.name === preferredModel ||
            model.id.endsWith(`/${preferredModel}`)) ?? localModels[0];
        const modelId = picked.id;
        const configuration = vscode.workspace.getConfiguration();
        const keys = [
            "github.copilot.chat.planAgent.model",
            "github.copilot.chat.implementAgent.model",
            "github.copilot.chat.searchSubagent.model",
        ];
        const alreadyConfigured = keys.every((key) => {
            const current = configuration.get(key, "").trim();
            return current.length > 0;
        });
        if (alreadyConfigured) {
            output.appendLine(`[local-qwen] Copilot agent model settings already configured; leaving existing values unchanged for keys: ${keys.join(", ")}.`);
            return;
        }
        for (const key of keys) {
            await configuration.update(key, modelId, vscode.ConfigurationTarget.Global);
        }
        output.appendLine(`[local-qwen] pinned Copilot agent model settings to '${modelId}' for keys: ${keys.join(", ")}. Preferred localQwen.model='${preferredModel || "(unset)"}'.`);
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[local-qwen] failed to pin Copilot agent models: ${text}`);
    }
}
//# sourceMappingURL=extension.js.map