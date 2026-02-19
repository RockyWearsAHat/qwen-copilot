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
exports.LocalLanguageModelProvider = void 0;
const vscode = __importStar(require("vscode"));
const ollamaClient_1 = require("./ollamaClient");
class LocalLanguageModelProvider {
    output;
    client = new ollamaClient_1.OllamaClient();
    constructor(output) {
        this.output = output;
    }
    async provideLanguageModelChatInformation(_options, token) {
        const configuration = vscode.workspace.getConfiguration('localQwen');
        const endpoint = configuration.get('endpoint', 'http://localhost:11434');
        const fallbackModel = configuration.get('model', 'qwen2.5:32b');
        const abortController = this.createAbortController(token);
        try {
            const models = await this.client.listModels(endpoint, abortController.signal);
            if (models.length === 0) {
                return [this.createFallbackInfo(fallbackModel)];
            }
            return models.map((model) => {
                const id = model.model ?? model.name;
                const family = model.details?.family ?? this.inferFamily(model.name);
                const detailParts = [model.details?.parameter_size, model.details?.quantization_level].filter(Boolean);
                return {
                    id,
                    name: model.name,
                    family,
                    version: model.modified_at ?? 'local',
                    detail: detailParts.join(' · ') || 'local model',
                    tooltip: `Local Ollama model: ${model.name}`,
                    maxInputTokens: 32768,
                    maxOutputTokens: 8192,
                    capabilities: {
                        toolCalling: true,
                        imageInput: family.includes('vl')
                    },
                    ollamaName: model.name
                };
            });
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[local-qwen] model listing failed: ${text}`);
            return [this.createFallbackInfo(fallbackModel)];
        }
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const configuration = vscode.workspace.getConfiguration('localQwen');
        const endpoint = configuration.get('endpoint', 'http://localhost:11434');
        const temperature = configuration.get('temperature', 0.2);
        const abortController = this.createAbortController(token);
        const request = {
            endpoint,
            model: model.ollamaName || model.id,
            temperature,
            messages: messages.map((message) => this.convertRequestMessage(message)),
            tools: this.toOllamaToolSpecs(options.tools ?? [])
        };
        const result = await this.client.chat(request, abortController.signal);
        for (const toolCall of result.message.tool_calls ?? []) {
            const toolInput = this.parseToolArgs(toolCall);
            progress.report(new vscode.LanguageModelToolCallPart(toolCall.id ?? this.nextCallId(), toolCall.function.name, toolInput));
        }
        if (result.message.content) {
            progress.report(new vscode.LanguageModelTextPart(result.message.content));
        }
    }
    async provideTokenCount(_model, text, _token) {
        const raw = typeof text === 'string' ? text : text.content.map((part) => this.partToText(part)).join(' ');
        return Math.max(1, Math.ceil(raw.length / 4));
    }
    createFallbackInfo(model) {
        return {
            id: model,
            name: model,
            family: this.inferFamily(model),
            version: 'local',
            detail: 'configured default',
            tooltip: `Local Ollama model: ${model}`,
            maxInputTokens: 32768,
            maxOutputTokens: 8192,
            capabilities: {
                toolCalling: true
            },
            ollamaName: model
        };
    }
    inferFamily(modelName) {
        const lower = modelName.toLowerCase();
        if (lower.includes('qwen')) {
            return 'qwen';
        }
        if (lower.includes('llama')) {
            return 'llama';
        }
        if (lower.includes('deepseek')) {
            return 'deepseek';
        }
        return 'local';
    }
    toOllamaToolSpecs(tools) {
        return tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: (tool.inputSchema ?? { type: 'object', additionalProperties: true })
            }
        }));
    }
    convertRequestMessage(message) {
        const content = message.content.map((part) => this.partToText(part)).join('\n').trim();
        const assistantToolCalls = message.role === vscode.LanguageModelChatMessageRole.Assistant
            ? message.content
                .filter((part) => part instanceof vscode.LanguageModelToolCallPart)
                .map((part) => ({
                id: part.callId,
                function: {
                    name: part.name,
                    arguments: part.input
                }
            }))
            : [];
        return {
            role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
            content,
            ...(assistantToolCalls.length > 0 ? { tool_calls: assistantToolCalls } : {})
        };
    }
    partToText(part) {
        if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
        }
        if (part instanceof vscode.LanguageModelToolResultPart) {
            const result = part.content
                .map((resultPart) => (resultPart instanceof vscode.LanguageModelTextPart ? resultPart.value : JSON.stringify(resultPart)))
                .join('\n');
            return `tool_result(${part.callId}): ${result}`;
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
            return `tool_call(${part.callId}): ${part.name} ${JSON.stringify(part.input)}`;
        }
        if (typeof part === 'string') {
            return part;
        }
        if (part && typeof part === 'object' && 'value' in part) {
            const value = part.value;
            if (typeof value === 'string') {
                return value;
            }
        }
        try {
            return JSON.stringify(part);
        }
        catch {
            return String(part);
        }
    }
    parseToolArgs(toolCall) {
        const raw = toolCall.function.arguments;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            }
            catch {
                return {};
            }
        }
        return raw ?? {};
    }
    createAbortController(token) {
        const abortController = new AbortController();
        if (token.isCancellationRequested) {
            abortController.abort();
        }
        else {
            token.onCancellationRequested(() => abortController.abort());
        }
        return abortController;
    }
    nextCallId() {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
exports.LocalLanguageModelProvider = LocalLanguageModelProvider;
//# sourceMappingURL=localLanguageModelProvider.js.map