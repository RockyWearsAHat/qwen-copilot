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
exports.SmokeTestRunner = void 0;
const vscode = __importStar(require("vscode"));
const ollamaClient_1 = require("../llm/ollamaClient");
class SmokeTestRunner {
    output;
    client = new ollamaClient_1.OllamaClient();
    constructor(output) {
        this.output = output;
    }
    async listModels(token) {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const endpoint = configuration.get("endpoint", "http://localhost:11434");
        const abortController = this.createAbortController(token);
        const models = await this.client.listModels(endpoint, abortController.signal);
        return models.map((model) => model.name);
    }
    async run(token) {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const endpoint = configuration.get("endpoint", "http://localhost:11434");
        const configuredModel = configuration.get("model", "qwen2.5:32b");
        const temperature = configuration.get("temperature", 0.2);
        const abortController = this.createAbortController(token);
        const models = await this.client.listModels(endpoint, abortController.signal);
        const availableModels = models.map((model) => model.name);
        const modelUsed = this.selectModel(configuredModel, availableModels);
        this.output.appendLine(`[local-qwen] smoke-test endpoint=${endpoint}`);
        this.output.appendLine(`[local-qwen] smoke-test models=${availableModels.join(", ") || "(none)"}`);
        this.output.appendLine(`[local-qwen] smoke-test using model=${modelUsed}`);
        const result = await this.client.chat({
            endpoint,
            model: modelUsed,
            temperature,
            tools: [],
            messages: [
                {
                    role: "user",
                    content: "Smoke test: respond with one short line that includes the word OK.",
                },
            ],
        }, abortController.signal);
        const responsePreview = (result.message.content ?? "").trim();
        return {
            endpoint,
            modelUsed,
            availableModels,
            responsePreview,
        };
    }
    selectModel(configuredModel, availableModels) {
        if (availableModels.includes(configuredModel)) {
            return configuredModel;
        }
        if (availableModels.length > 0) {
            return availableModels[0];
        }
        return configuredModel;
    }
    createAbortController(token) {
        const abortController = new AbortController();
        if (!token) {
            return abortController;
        }
        if (token.isCancellationRequested) {
            abortController.abort();
        }
        else {
            token.onCancellationRequested(() => abortController.abort());
        }
        return abortController;
    }
}
exports.SmokeTestRunner = SmokeTestRunner;
//# sourceMappingURL=smokeTestRunner.js.map