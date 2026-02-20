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
    static toolCallStart = "<local_qwen_tool_call>";
    static toolCallEnd = "</local_qwen_tool_call>";
    modelInfoChangedEmitter = new vscode.EventEmitter();
    onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    client = new ollamaClient_1.OllamaClient();
    cachedModelInfos;
    inFlightModelInfoRequest;
    activeChatRequests = 0;
    chatWaiters = [];
    constructor(output) {
        this.output = output;
    }
    async warmModelInfos() {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const endpoint = configuration.get("endpoint", "http://localhost:11434");
        const fallbackModel = configuration.get("model", "qwen2.5:32b");
        try {
            await this.fetchModelInfos(endpoint, fallbackModel);
            this.modelInfoChangedEmitter.fire();
        }
        catch {
            // fetchModelInfos already emits fallback and logs failures.
            this.modelInfoChangedEmitter.fire();
        }
    }
    invalidateModelInfos() {
        this.cachedModelInfos = undefined;
        this.inFlightModelInfoRequest = undefined;
    }
    dispose() {
        this.modelInfoChangedEmitter.dispose();
    }
    async provideLanguageModelChatInformation(_options, token) {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const endpoint = configuration.get("endpoint", "http://localhost:11434");
        const fallbackModel = configuration.get("model", "qwen2.5:32b");
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const cached = this.getCachedModelInfos();
        if (cached) {
            return cached;
        }
        if (!this.inFlightModelInfoRequest) {
            this.inFlightModelInfoRequest = this.fetchModelInfos(endpoint, fallbackModel).finally(() => {
                this.inFlightModelInfoRequest = undefined;
            });
        }
        return this.inFlightModelInfoRequest;
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const endpoint = configuration.get("endpoint", "http://localhost:11434");
        const temperature = configuration.get("temperature", 0.2);
        const timeoutMs = configuration.get("requestTimeoutMs", 120000);
        const maxOutputTokens = configuration.get("maxOutputTokens", 0);
        const contextWindowTokens = configuration.get("contextWindowTokens", 0);
        const maxConcurrentRequests = configuration.get("maxConcurrentRequests", 1);
        const maxRequestMessages = configuration.get("maxRequestMessages", 0);
        const maxRequestChars = configuration.get("maxRequestChars", 0);
        const maxToolsPerRequest = configuration.get("maxToolsPerRequest", 0);
        const toolSchemaMode = configuration.get("toolSchemaMode", "compact");
        const toolCallBridgeMode = configuration.get("toolCallBridgeMode", "native-then-delimited");
        const logRequestStats = configuration.get("logRequestStats", true);
        const abortController = this.createAbortController(token);
        const convertedMessages = messages.map((message) => this.convertRequestMessage(message));
        const shapedMessages = this.shapeMessages(convertedMessages, maxRequestMessages, maxRequestChars);
        const allTools = this.toOllamaToolSpecs(options.tools ?? [], toolSchemaMode);
        const shapedTools = this.shapeTools(allTools, maxToolsPerRequest);
        const useDelimitedBridge = toolCallBridgeMode === "delimited";
        const requestMessages = useDelimitedBridge
            ? this.withDelimitedToolBridge(shapedMessages, shapedTools)
            : shapedMessages;
        const requestTools = useDelimitedBridge ? [] : shapedTools;
        if (convertedMessages.length !== shapedMessages.length) {
            this.output.appendLine(`[local-qwen] reduced request history from ${convertedMessages.length} to ${shapedMessages.length} message(s).`);
        }
        if (allTools.length !== shapedTools.length) {
            this.output.appendLine(`[local-qwen] reduced tool specs from ${allTools.length} to ${shapedTools.length}.`);
        }
        const request = {
            endpoint,
            model: model.ollamaName || model.id,
            temperature,
            maxOutputTokens,
            contextWindowTokens,
            messages: requestMessages,
            tools: requestTools,
        };
        if (logRequestStats) {
            const messageChars = requestMessages.reduce((sum, message) => sum + this.estimateMessageSize(message), 0);
            const toolChars = JSON.stringify(requestTools).length;
            const approxPromptTokens = Math.ceil((messageChars + toolChars) / 4);
            this.output.appendLine(`[local-qwen] request stats: messages=${requestMessages.length}, tools=${requestTools.length}, approxPromptTokens=${approxPromptTokens}, messageChars=${messageChars}, toolChars=${toolChars}, bridge=${toolCallBridgeMode}, num_ctx=${contextWindowTokens > 0 ? contextWindowTokens : "model-default"}, num_predict=${maxOutputTokens > 0 ? maxOutputTokens : "model-default"}`);
        }
        await this.acquireChatSlot(Math.max(1, maxConcurrentRequests), token);
        let result;
        let usedDelimitedBridge = useDelimitedBridge;
        try {
            result = await this.client.chat(request, abortController.signal, timeoutMs);
        }
        catch (error) {
            if (!this.shouldRetryWithoutTools(error, request.tools)) {
                throw error;
            }
            if (toolCallBridgeMode === "native") {
                this.output.appendLine(`[local-qwen] model '${request.model}' does not support native tools and bridge mode is 'native'.`);
                throw error;
            }
            usedDelimitedBridge = true;
            this.output.appendLine(`[local-qwen] model '${request.model}' does not support native tools; retrying with delimiter-based tool bridge.`);
            result = await this.client.chat({
                ...request,
                tools: [],
                messages: this.withDelimitedToolBridge(shapedMessages, shapedTools),
            }, abortController.signal, timeoutMs);
        }
        finally {
            this.releaseChatSlot();
        }
        const nativeToolCalls = result.message.tool_calls ?? [];
        let finalContent = result.message.content ?? "";
        const delimiterParse = this.extractDelimitedToolCalls(finalContent);
        if (delimiterParse.toolCalls.length > 0) {
            finalContent = delimiterParse.cleanedContent;
            if (usedDelimitedBridge) {
                this.output.appendLine(`[local-qwen] parsed ${delimiterParse.toolCalls.length} delimiter tool call(s).`);
            }
        }
        const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : delimiterParse.toolCalls;
        for (const toolCall of toolCalls) {
            const toolInput = this.parseToolArgs(toolCall);
            progress.report(new vscode.LanguageModelToolCallPart(toolCall.id ?? this.nextCallId(), toolCall.function.name, toolInput));
        }
        if (finalContent.trim().length > 0) {
            progress.report(new vscode.LanguageModelTextPart(finalContent));
        }
    }
    async provideTokenCount(_model, text, _token) {
        const raw = typeof text === "string"
            ? text
            : text.content.map((part) => this.partToText(part)).join(" ");
        return Math.max(1, Math.ceil(raw.length / 4));
    }
    createFallbackInfo(model) {
        return {
            id: model,
            name: model,
            family: this.inferFamily(model),
            version: "local",
            detail: "configured default",
            tooltip: `Local Ollama model: ${model}`,
            maxInputTokens: 32768,
            maxOutputTokens: 8192,
            capabilities: {
                toolCalling: true,
            },
            ollamaName: model,
        };
    }
    async fetchModelInfos(endpoint, fallbackModel) {
        const modelListTimeoutMs = vscode.workspace
            .getConfiguration("localQwen")
            .get("modelListTimeoutMs", 7000);
        const ttlMs = vscode.workspace
            .getConfiguration("localQwen")
            .get("modelListCacheTtlMs", 10000);
        const controller = new AbortController();
        try {
            const models = await this.client.listModels(endpoint, controller.signal, modelListTimeoutMs);
            const infos = models.length === 0
                ? [this.createFallbackInfo(fallbackModel)]
                : models.map((model) => {
                    const id = model.model ?? model.name;
                    const family = model.details?.family ?? this.inferFamily(model.name);
                    const detailParts = [
                        model.details?.parameter_size,
                        model.details?.quantization_level,
                    ].filter(Boolean);
                    return {
                        id,
                        name: model.name,
                        family,
                        version: model.modified_at ?? "local",
                        detail: detailParts.join(" · ") || "local model",
                        tooltip: `Local Ollama model: ${model.name}`,
                        maxInputTokens: 32768,
                        maxOutputTokens: 8192,
                        capabilities: {
                            toolCalling: true,
                            imageInput: family.includes("vl"),
                        },
                        ollamaName: model.name,
                    };
                });
            this.cachedModelInfos = {
                expiresAt: Date.now() + Math.max(1000, ttlMs),
                infos,
            };
            return infos;
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[local-qwen] model listing failed: ${text}`);
            const fallbackInfos = [this.createFallbackInfo(fallbackModel)];
            this.cachedModelInfos = {
                expiresAt: Date.now() + Math.max(1000, ttlMs),
                infos: fallbackInfos,
            };
            return fallbackInfos;
        }
    }
    getCachedModelInfos() {
        if (!this.cachedModelInfos) {
            return undefined;
        }
        if (this.cachedModelInfos.expiresAt < Date.now()) {
            this.cachedModelInfos = undefined;
            return undefined;
        }
        return this.cachedModelInfos.infos;
    }
    inferFamily(modelName) {
        const lower = modelName.toLowerCase();
        if (lower.includes("qwen")) {
            return "qwen";
        }
        if (lower.includes("llama")) {
            return "llama";
        }
        if (lower.includes("deepseek")) {
            return "deepseek";
        }
        return "local";
    }
    toOllamaToolSpecs(tools, schemaMode) {
        return tools.map((tool) => {
            const defaultParams = {
                type: "object",
                additionalProperties: true,
            };
            if (schemaMode === "names-only") {
                return {
                    type: "function",
                    function: {
                        name: tool.name,
                        description: "",
                        parameters: defaultParams,
                    },
                };
            }
            if (schemaMode === "compact") {
                const compactDescription = (tool.description ?? "").slice(0, 160);
                return {
                    type: "function",
                    function: {
                        name: tool.name,
                        description: compactDescription,
                        parameters: defaultParams,
                    },
                };
            }
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: (tool.inputSchema ?? defaultParams),
                },
            };
        });
    }
    shapeMessages(messages, maxMessages, maxChars) {
        if (maxMessages <= 0 && maxChars <= 0) {
            return messages;
        }
        const safeMaxMessages = Math.max(1, maxMessages);
        const safeMaxChars = maxChars > 0 ? Math.max(500, maxChars) : Number.MAX_SAFE_INTEGER;
        const tail = messages.slice(-safeMaxMessages);
        const selected = [];
        let runningChars = 0;
        for (let index = tail.length - 1; index >= 0; index -= 1) {
            const message = tail[index];
            const messageChars = this.estimateMessageSize(message);
            if (selected.length > 0 && runningChars + messageChars > safeMaxChars) {
                break;
            }
            selected.push(message);
            runningChars += messageChars;
            if (runningChars >= safeMaxChars) {
                break;
            }
        }
        return selected.reverse();
    }
    shapeTools(tools, maxToolsPerRequest) {
        if (maxToolsPerRequest <= 0) {
            return tools;
        }
        const safeMax = Math.max(1, maxToolsPerRequest);
        return tools.slice(0, safeMax);
    }
    withDelimitedToolBridge(messages, tools) {
        if (tools.length === 0) {
            return messages;
        }
        const catalog = tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
        }));
        const instruction = [
            "Tool-call bridge mode is active.",
            `When you need a tool, output ONLY this exact wrapper: ${LocalLanguageModelProvider.toolCallStart}{\"name\":\"tool_name\",\"arguments\":{...}}${LocalLanguageModelProvider.toolCallEnd}`,
            "You may emit multiple wrapped tool calls.",
            "Do not include markdown fences around the wrapper.",
            `Available tools: ${JSON.stringify(catalog)}`,
        ].join("\n");
        return [
            {
                role: "system",
                content: instruction,
            },
            ...messages,
        ];
    }
    extractDelimitedToolCalls(content) {
        const start = LocalLanguageModelProvider.toolCallStart;
        const end = LocalLanguageModelProvider.toolCallEnd;
        const expression = new RegExp(`${start}([\\s\\S]*?)${end}`, "g");
        const toolCalls = [];
        let cleaned = content;
        const matches = Array.from(content.matchAll(expression));
        for (const match of matches) {
            const payloadText = match[1]?.trim();
            if (!payloadText) {
                continue;
            }
            try {
                const payload = JSON.parse(payloadText);
                const name = typeof payload.name === "string" ? payload.name.trim() : "";
                if (!name) {
                    continue;
                }
                const args = payload.arguments ?? payload.input ?? {};
                toolCalls.push({
                    id: this.nextCallId(),
                    function: {
                        name,
                        arguments: typeof args === "string" ||
                            (args && typeof args === "object" && !Array.isArray(args))
                            ? args
                            : {},
                    },
                });
            }
            catch {
                continue;
            }
        }
        if (matches.length > 0) {
            cleaned = content.replace(expression, "").trim();
        }
        return {
            cleanedContent: cleaned,
            toolCalls,
        };
    }
    estimateMessageSize(message) {
        const contentSize = message.content.length;
        const toolCallSize = JSON.stringify(message.tool_calls ?? []).length;
        const imageSize = (message.images?.length ?? 0) * 500;
        return contentSize + toolCallSize + imageSize + 24;
    }
    convertRequestMessage(message) {
        const textSegments = [];
        const images = [];
        for (const part of message.content) {
            const imageBase64 = this.extractImageBase64(part);
            if (imageBase64) {
                images.push(imageBase64);
                continue;
            }
            const text = this.partToText(part).trim();
            if (text.length > 0) {
                textSegments.push(text);
            }
        }
        const content = textSegments.join("\n").trim();
        const mappedRole = this.mapMessageRole(message.role);
        const assistantToolCalls = mappedRole === "assistant"
            ? message.content
                .filter((part) => part instanceof vscode.LanguageModelToolCallPart)
                .map((part) => ({
                id: part.callId,
                function: {
                    name: part.name,
                    arguments: part.input,
                },
            }))
            : [];
        return {
            role: mappedRole,
            content,
            ...(images.length > 0 ? { images } : {}),
            ...(assistantToolCalls.length > 0
                ? { tool_calls: assistantToolCalls }
                : {}),
        };
    }
    mapMessageRole(role) {
        const normalized = String(role).toLowerCase();
        if (normalized.includes("assistant")) {
            return "assistant";
        }
        if (normalized.includes("system")) {
            return "system";
        }
        if (normalized.includes("tool")) {
            return "tool";
        }
        return "user";
    }
    extractImageBase64(part) {
        if (!part || typeof part !== "object") {
            return undefined;
        }
        const candidate = part;
        const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : undefined;
        if (!mimeType || !mimeType.startsWith("image/")) {
            return undefined;
        }
        const payload = candidate.data ?? candidate.value;
        if (!payload) {
            return undefined;
        }
        return this.toBase64(payload);
    }
    toBase64(payload) {
        if (payload instanceof Uint8Array) {
            return Buffer.from(payload).toString("base64");
        }
        if (payload instanceof ArrayBuffer) {
            return Buffer.from(new Uint8Array(payload)).toString("base64");
        }
        if (Array.isArray(payload) &&
            payload.every((entry) => typeof entry === "number")) {
            return Buffer.from(payload).toString("base64");
        }
        if (payload &&
            typeof payload === "object" &&
            "type" in payload &&
            payload.type === "Buffer" &&
            "data" in payload &&
            Array.isArray(payload.data)) {
            return Buffer.from(payload.data).toString("base64");
        }
        return undefined;
    }
    partToText(part) {
        if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
        }
        if (part instanceof vscode.LanguageModelToolResultPart) {
            const result = part.content
                .map((resultPart) => resultPart instanceof vscode.LanguageModelTextPart
                ? resultPart.value
                : "")
                .filter((entry) => entry.length > 0)
                .join("\n");
            if (!result) {
                return "";
            }
            return result;
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
            return "";
        }
        if (typeof part === "string") {
            return part;
        }
        if (part && typeof part === "object" && "value" in part) {
            const value = part.value;
            if (typeof value === "string") {
                return value;
            }
        }
        return "";
    }
    parseToolArgs(toolCall) {
        const raw = toolCall.function.arguments;
        if (typeof raw === "string") {
            try {
                return JSON.parse(raw);
            }
            catch {
                return {};
            }
        }
        return raw ?? {};
    }
    shouldRetryWithoutTools(error, tools) {
        if (tools.length === 0 || !(error instanceof Error)) {
            return false;
        }
        return /does not support tools/i.test(error.message);
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
    async acquireChatSlot(maxConcurrentRequests, token) {
        while (this.activeChatRequests >= maxConcurrentRequests) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            await new Promise((resolve, reject) => {
                let releaseWaiter;
                const disposeCancellation = token.onCancellationRequested(() => {
                    const index = releaseWaiter
                        ? this.chatWaiters.indexOf(releaseWaiter)
                        : -1;
                    if (index >= 0) {
                        this.chatWaiters.splice(index, 1);
                    }
                    disposeCancellation.dispose();
                    reject(new vscode.CancellationError());
                });
                releaseWaiter = () => {
                    disposeCancellation.dispose();
                    resolve();
                };
                this.chatWaiters.push(releaseWaiter);
            });
        }
        this.activeChatRequests += 1;
    }
    releaseChatSlot() {
        this.activeChatRequests = Math.max(0, this.activeChatRequests - 1);
        const waiter = this.chatWaiters.shift();
        waiter?.();
    }
    nextCallId() {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
exports.LocalLanguageModelProvider = LocalLanguageModelProvider;
//# sourceMappingURL=localLanguageModelProvider.js.map