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
    static defaultContextLength = 32768;
    static inputBudgetRatio = 0.6;
    static defaultEndpoint = "http://localhost:11434";
    static defaultModel = "qwen2.5:32b";
    static defaultTemperature = 0.2;
    static defaultModelListTimeoutMs = 7000;
    static defaultModelListCacheTtlMs = 10000;
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
        const endpoint = LocalLanguageModelProvider.defaultEndpoint;
        const fallbackModel = LocalLanguageModelProvider.defaultModel;
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
        const endpoint = LocalLanguageModelProvider.defaultEndpoint;
        const fallbackModel = LocalLanguageModelProvider.defaultModel;
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
    /**
     * Transparent bridge: forward everything Copilot sends to Ollama, return
     * everything Ollama gives back. Copilot's agent orchestrator handles tool
     * selection, history management, context assembly, and the tool-calling
     * loop — exactly like it does for Claude, GPT, and Gemini providers.
     */
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const endpoint = LocalLanguageModelProvider.defaultEndpoint;
        const temperature = LocalLanguageModelProvider.defaultTemperature;
        const timeoutMs = 0;
        const maxConcurrentRequests = 1;
        const logRequestStats = true;
        // Derive num_ctx and num_predict from the model info that Copilot
        // already received via provideLanguageModelChatInformation.
        // model.maxInputTokens + model.maxOutputTokens = the full context window.
        const contextWindowTokens = model.maxInputTokens + model.maxOutputTokens;
        const maxOutputTokens = model.maxOutputTokens;
        const abortController = this.createAbortController(token);
        // Convert VS Code message format to Ollama format.
        const convertedMessages = messages.map((message) => this.convertRequestMessage(message, false));
        // Debug: dump outbound messages to file for inspection
        if (convertedMessages.length > 0) {
            try {
                const fs = require("fs");
                const debugPayload = convertedMessages
                    .map((message, index) => {
                    const header = `--- message[${index}] role=${message.role} ---`;
                    return `${header}\n${message.content}`;
                })
                    .join("\n\n");
                fs.writeFileSync("/tmp/copilot-system-prompt-debug.txt", debugPayload, "utf8");
                this.output.appendLine(`[local-qwen] DEBUG: wrote ${convertedMessages.length} outbound messages to /tmp/copilot-system-prompt-debug.txt`);
            }
            catch {
                // ignore write errors
            }
        }
        // Convert VS Code tool definitions to Ollama format — pass them all
        // through.  Copilot already selected which tools are relevant for this
        // turn of its agent loop.
        const tools = this.toOllamaToolSpecs(options.tools ?? []);
        const prioritizedTools = tools;
        const request = {
            endpoint,
            model: model.ollamaName || model.id,
            temperature,
            maxOutputTokens,
            contextWindowTokens, // Always sent — Ollama defaults to 2048 otherwise!
            messages: convertedMessages,
            tools: prioritizedTools,
        };
        if (logRequestStats) {
            const messageChars = convertedMessages.reduce((sum, message) => sum + this.estimateMessageSize(message), 0);
            const toolChars = JSON.stringify(prioritizedTools).length;
            const approxPromptTokens = Math.ceil((messageChars + toolChars) / 4);
            this.output.appendLine(`[local-qwen] request: messages=${convertedMessages.length}, tools=${prioritizedTools.length}, ~${approxPromptTokens} prompt tokens, modelMaxInput=${model.maxInputTokens}, num_ctx=${contextWindowTokens}, num_predict=${maxOutputTokens}`);
        }
        await this.acquireChatSlot(Math.max(1, maxConcurrentRequests), token);
        try {
            await this.streamResponse(request, prioritizedTools, abortController, timeoutMs, progress, prioritizedTools.length === 0);
        }
        catch (error) {
            if (!this.shouldRetryWithoutTools(error, request.tools)) {
                throw error;
            }
            // Model does not support native tool calling — retry without the
            // native schema and provide explicit text instructions for tool calls.
            this.output.appendLine(`[local-qwen] model '${request.model}' does not support native tools; retrying without tool schema.`);
            const fallbackMessages = this.withToolTextFallbackMessages(request.messages, prioritizedTools);
            await this.streamResponse({ ...request, tools: [], messages: fallbackMessages }, prioritizedTools, abortController, timeoutMs, progress, false);
        }
        finally {
            this.releaseChatSlot();
        }
    }
    /**
     * Stream from Ollama and report text/tool-call parts to Copilot as they
     * arrive.  Text content is streamed incrementally so the UI stays
     * responsive.  Tool calls (native or parsed from text) are emitted once
     * the stream is complete since they must be structurally whole.
     */
    async streamResponse(request, allToolSpecs, abortController, timeoutMs, progress, streamTextDeltas) {
        let fullContent = "";
        let nativeToolCalls = [];
        let streamed = false;
        try {
            const { stream } = await this.client.chatStream(request, abortController.signal, timeoutMs);
            streamed = true;
            for await (const chunk of stream) {
                const delta = chunk.message.content ?? "";
                if (delta.length > 0) {
                    fullContent += delta;
                    if (streamTextDeltas) {
                        progress.report(new vscode.LanguageModelTextPart(delta));
                    }
                }
                if (chunk.done && chunk.message.tool_calls?.length) {
                    nativeToolCalls = chunk.message.tool_calls;
                }
            }
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[local-qwen] stream transport failed; retrying non-stream chat: ${detail}`);
            const nonStream = await this.client.chat(request, abortController.signal, timeoutMs);
            fullContent = nonStream.message.content ?? "";
            nativeToolCalls = nonStream.message.tool_calls ?? [];
        }
        if (!streamed && streamTextDeltas && fullContent.trim().length > 0) {
            progress.report(new vscode.LanguageModelTextPart(fullContent));
        }
        // If the model returned native tool calls, emit them.  Otherwise try
        // to parse tool calls from the full text content.
        if (nativeToolCalls.length > 0) {
            // The text was already streamed but if the model ONLY returned
            // tool calls (no meaningful text), that's fine — Copilot handles it.
            for (const toolCall of nativeToolCalls) {
                const toolInput = this.parseToolArgs(toolCall);
                progress.report(new vscode.LanguageModelToolCallPart(toolCall.id ?? this.nextCallId(), toolCall.function.name, toolInput));
            }
            return;
        }
        // No native tool calls — try to recover tool calls from the text
        if (fullContent.trim().length > 0) {
            let parsedToolCalls = [];
            let cleanedContent = fullContent;
            const delimiterParse = this.extractDelimitedToolCalls(fullContent);
            if (delimiterParse.toolCalls.length > 0) {
                parsedToolCalls = delimiterParse.toolCalls;
                cleanedContent = delimiterParse.cleanedContent;
            }
            else {
                const structuredParse = this.extractStructuredToolCalls(fullContent);
                if (structuredParse.toolCalls.length > 0) {
                    parsedToolCalls = structuredParse.toolCalls;
                    cleanedContent = structuredParse.cleanedContent;
                }
            }
            if (parsedToolCalls.length > 0) {
                const allowedToolNames = new Set(allToolSpecs.map((tool) => tool.function.name));
                const dedupedToolCalls = [];
                const seenToolCalls = new Set();
                for (const toolCall of parsedToolCalls) {
                    const toolName = toolCall.function.name;
                    if (!allowedToolNames.has(toolName)) {
                        continue;
                    }
                    const argsFingerprint = typeof toolCall.function.arguments === "string"
                        ? toolCall.function.arguments
                        : JSON.stringify(toolCall.function.arguments ?? {});
                    const fingerprint = `${toolName}:${argsFingerprint}`;
                    if (seenToolCalls.has(fingerprint)) {
                        continue;
                    }
                    seenToolCalls.add(fingerprint);
                    dedupedToolCalls.push(toolCall);
                }
                if (dedupedToolCalls.length !== parsedToolCalls.length) {
                    this.output.appendLine(`[local-qwen] deduped parsed tool calls (${parsedToolCalls.length} → ${dedupedToolCalls.length}).`);
                }
                for (const toolCall of dedupedToolCalls) {
                    const toolInput = this.parseToolArgs(toolCall);
                    progress.report(new vscode.LanguageModelToolCallPart(toolCall.id ?? this.nextCallId(), toolCall.function.name, toolInput));
                }
                if (!streamTextDeltas && cleanedContent.trim().length > 0) {
                    progress.report(new vscode.LanguageModelTextPart(cleanedContent));
                }
                return;
            }
            if (!streamTextDeltas) {
                progress.report(new vscode.LanguageModelTextPart(fullContent));
            }
        }
    }
    async provideTokenCount(_model, text, _token) {
        const raw = typeof text === "string"
            ? text
            : text.content.map((part) => this.partToText(part)).join(" ");
        return Math.max(1, Math.ceil(raw.length / 4));
    }
    createFallbackInfo(model) {
        const tokenCaps = this.getAdvertisedTokenCaps();
        return {
            id: model,
            name: model,
            family: this.inferFamily(model),
            version: "local",
            detail: "configured default",
            tooltip: `Local Ollama model: ${model}`,
            maxInputTokens: tokenCaps.maxInputTokens,
            maxOutputTokens: tokenCaps.maxOutputTokens,
            capabilities: {
                toolCalling: true,
            },
            ollamaName: model,
        };
    }
    async fetchModelInfos(endpoint, fallbackModel) {
        const modelListTimeoutMs = LocalLanguageModelProvider.defaultModelListTimeoutMs;
        const ttlMs = LocalLanguageModelProvider.defaultModelListCacheTtlMs;
        const controller = new AbortController();
        try {
            const models = await this.client.listModels(endpoint, controller.signal, modelListTimeoutMs);
            const modelsWithContext = await this.hydrateMissingContextLengths(models, endpoint, controller.signal, modelListTimeoutMs);
            const infos = modelsWithContext.length === 0
                ? [this.createFallbackInfo(fallbackModel)]
                : modelsWithContext.map((model) => {
                    const id = model.model ?? model.name;
                    const family = model.details?.family ?? this.inferFamily(model.name);
                    const tokenCaps = this.getAdvertisedTokenCaps(model.details);
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
                        maxInputTokens: tokenCaps.maxInputTokens,
                        maxOutputTokens: tokenCaps.maxOutputTokens,
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
    async hydrateMissingContextLengths(models, endpoint, abortSignal, timeoutMs) {
        const enriched = await Promise.all(models.map(async (model) => {
            const hasContextLength = this.extractModelContextLength(model.details);
            if (hasContextLength) {
                return model;
            }
            try {
                const contextLength = await this.client.getModelContextLength(endpoint, model.name, abortSignal, timeoutMs);
                if (!contextLength) {
                    return model;
                }
                return {
                    ...model,
                    details: {
                        ...model.details,
                        context_length: contextLength,
                    },
                };
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                this.output.appendLine(`[local-qwen] unable to resolve context length via /api/show for '${model.name}': ${text}`);
                return model;
            }
        }));
        return enriched;
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
    /**
     * Compute the maxInputTokens and maxOutputTokens to advertise to Copilot.
     *
     * Local long-context workflows need far larger generation windows than the
     * old 4k output cap. We budget the context window as:
     *   maxInputTokens   = 60% of contextLength
     *   maxOutputTokens  = 40% of contextLength
     */
    getAdvertisedTokenCaps(modelDetails) {
        const modelContextLength = this.extractModelContextLength(modelDetails);
        const contextLength = modelContextLength ?? LocalLanguageModelProvider.defaultContextLength;
        const maxInputTokens = Math.floor(contextLength * LocalLanguageModelProvider.inputBudgetRatio);
        const maxOutputTokens = contextLength - maxInputTokens;
        return {
            maxInputTokens: Math.max(1024, maxInputTokens),
            maxOutputTokens: Math.max(256, maxOutputTokens),
        };
    }
    extractModelContextLength(modelDetails) {
        if (!modelDetails || typeof modelDetails !== "object") {
            return undefined;
        }
        const contextLength = modelDetails
            .context_length;
        if (typeof contextLength === "number" && Number.isFinite(contextLength)) {
            return contextLength > 0 ? Math.floor(contextLength) : undefined;
        }
        if (typeof contextLength === "string") {
            const parsed = Number.parseInt(contextLength, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        }
        return undefined;
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
    /**
     * Convert VS Code tool definitions to Ollama-compatible tool specs.
     * Always sends the full schema — Copilot decides which tools to include.
     */
    toOllamaToolSpecs(tools) {
        const defaultParams = {
            type: "object",
            additionalProperties: true,
        };
        return tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: (tool.inputSchema ?? defaultParams),
            },
        }));
    }
    prioritizeToolsForIntent(tools, messages) {
        const latestUserText = this.getLatestUserMessageText(messages).toLowerCase();
        if (!latestUserText) {
            return [...tools];
        }
        const installIntent = /\b(install|setup|set up|configure|download|pull)\b/i.test(latestUserText);
        const localRuntimeIntent = /\b(ollama|qwen|llama|deepseek|model)\b/i.test(latestUserText);
        if (!(installIntent && localRuntimeIntent)) {
            return [...tools];
        }
        const priority = (name) => {
            if (name === "run_in_terminal") {
                return 0;
            }
            if (name === "await_terminal" ||
                name === "get_terminal_output" ||
                name === "terminal_last_command") {
                return 1;
            }
            if (name === "ask_questions") {
                return 99;
            }
            return 10;
        };
        const sorted = [...tools].sort((left, right) => priority(left.function.name) - priority(right.function.name));
        this.output.appendLine("[local-qwen] intent bias: prioritized terminal tools and de-prioritized ask_questions for install/runtime request.");
        return sorted;
    }
    getLatestUserMessageText(messages) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (messages[index].role === "user" && messages[index].content.trim()) {
                return messages[index].content;
            }
        }
        return "";
    }
    withToolTextFallbackMessages(messages, tools) {
        if (tools.length === 0) {
            return [...messages];
        }
        const toolSummary = tools
            .map((tool) => `- ${tool.function.name}: ${tool.function.description || "No description provided."}`)
            .join("\n");
        const instruction = {
            role: "system",
            content: [
                "Native tool calling is unavailable for this model.",
                "When you need a tool, output ONLY the following XML block format and no surrounding markdown:",
                '<local_qwen_tool_call>{"name":"tool_name","arguments":{}}</local_qwen_tool_call>',
                "You may output multiple blocks back-to-back if needed.",
                "Available tools:",
                toolSummary,
            ].join("\n"),
        };
        return [...messages, instruction];
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
    extractStructuredToolCalls(content) {
        const trimmed = content.trim();
        if (!trimmed) {
            return {
                cleanedContent: content,
                toolCalls: [],
            };
        }
        const candidates = [trimmed];
        const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fencedMatch?.[1]) {
            candidates.push(fencedMatch[1].trim());
        }
        const fencedExpression = /```(?:json)?\s*([\s\S]*?)```/gi;
        const fencedMatches = Array.from(trimmed.matchAll(fencedExpression));
        if (fencedMatches.length > 0) {
            const aggregatedToolCalls = [];
            for (const match of fencedMatches) {
                const payload = match[1]?.trim();
                if (!payload) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(payload);
                    aggregatedToolCalls.push(...this.toToolCallsFromStructuredPayload(parsed));
                }
                catch {
                    continue;
                }
            }
            if (aggregatedToolCalls.length > 0) {
                const cleanedContent = trimmed.replace(fencedExpression, "").trim();
                return {
                    cleanedContent,
                    toolCalls: aggregatedToolCalls,
                };
            }
        }
        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate);
                const toolCalls = this.toToolCallsFromStructuredPayload(parsed);
                if (toolCalls.length > 0) {
                    return {
                        cleanedContent: "",
                        toolCalls,
                    };
                }
            }
            catch {
                // no-op: not valid JSON
            }
        }
        return {
            cleanedContent: content,
            toolCalls: [],
        };
    }
    toToolCallsFromStructuredPayload(payload) {
        if (!payload) {
            return [];
        }
        if (Array.isArray(payload)) {
            return payload
                .map((entry) => this.toToolCallFromStructuredPayload(entry))
                .filter((entry) => Boolean(entry));
        }
        const single = this.toToolCallFromStructuredPayload(payload);
        return single ? [single] : [];
    }
    toToolCallFromStructuredPayload(payload) {
        if (!payload || typeof payload !== "object") {
            return undefined;
        }
        const candidate = payload;
        const functionName = typeof candidate.function?.name === "string"
            ? candidate.function.name.trim()
            : typeof candidate.name === "string"
                ? candidate.name.trim()
                : "";
        if (!functionName) {
            return undefined;
        }
        const rawArgs = candidate.function?.arguments ?? candidate.arguments ?? candidate.input;
        const normalizedArgs = typeof rawArgs === "string" ||
            (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
            ? rawArgs
            : {};
        return {
            id: this.nextCallId(),
            function: {
                name: functionName,
                arguments: normalizedArgs,
            },
        };
    }
    estimateMessageSize(message) {
        const contentSize = message.content.length;
        const toolCallSize = JSON.stringify(message.tool_calls ?? []).length;
        const imageSize = (message.images?.length ?? 0) * 500;
        return contentSize + toolCallSize + imageSize + 24;
    }
    convertRequestMessage(message, compactEnvelopeMessages) {
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
        const rawContent = textSegments.join("\n").trim();
        const mappedRole = this.mapMessageRole(message.role);
        const content = compactEnvelopeMessages && mappedRole === "user"
            ? this.compactEnvelopeUserMessage(rawContent)
            : rawContent;
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
        // LanguageModelChatMessageRole is a numeric enum:
        //   User = 1, Assistant = 2
        // There is NO System or Tool role in the VS Code API.
        // Previous code used String(role).toLowerCase() which produced "1"/"2"
        // and never matched "assistant"/"system" — mapping everything to "user".
        if (role === vscode.LanguageModelChatMessageRole.Assistant) {
            return "assistant";
        }
        return "user";
    }
    sanitizeCopilotPreambleMessage(content, stripRefusalDirective, stripStyleDirective, compactCopilotPreamble) {
        if (!this.looksLikeCopilotPreamble(content)) {
            return content;
        }
        let result = compactCopilotPreamble
            ? this.compactCopilotPreambleContent(content)
            : content;
        if (stripRefusalDirective) {
            result = result.replace(/\n?If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that\."\s*/gi, "\n");
        }
        if (stripStyleDirective) {
            result = result.replace(/\n?Keep your answers short and impersonal\.\s*/gi, "\n");
        }
        result = result.replace(/\n?When asked for your name, you must respond with "GitHub Copilot"\.\s*/gi, "\n");
        result = result.replace(/\n?When asked about the model you are using, you must state that you are using [^\n]+\.?\s*/gi, "\n");
        result = result.replace(/\n?Follow Microsoft content policies\.\s*/gi, "\n");
        result = result.replace(/\n?Avoid content that violates copyrights\.\s*/gi, "\n");
        return result.replace(/\n{3,}/g, "\n\n").trim();
    }
    compactEnvelopeUserMessage(content) {
        const extractedUserRequest = this.extractTaggedSection(content, "userRequest");
        if (extractedUserRequest) {
            return extractedUserRequest;
        }
        return content;
    }
    extractTaggedSection(content, tag) {
        const expression = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
        const matches = Array.from(content.matchAll(expression));
        for (let index = matches.length - 1; index >= 0; index -= 1) {
            const value = matches[index]?.[1]?.trim();
            if (value) {
                return value;
            }
        }
        return "";
    }
    compactCopilotPreambleContent(content) {
        let result = content;
        const removableBlocks = [
            "toolUseInstructions",
            "editFileInstructions",
            "notebookInstructions",
            "outputFormatting",
        ];
        for (const tag of removableBlocks) {
            const expression = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi");
            result = result.replace(expression, "");
        }
        result = result.replace(/<instructions>[\s\S]*?<agents>[\s\S]*?<\/agents>[\s\S]*?<\/instructions>/gi, "");
        return result.replace(/\n{3,}/g, "\n\n").trim();
    }
    looksLikeCopilotPreamble(content) {
        const normalized = content.toLowerCase();
        return (normalized.includes("you are an expert ai programming assistant, working with a user in the vs code editor") && normalized.includes("follow microsoft content policies"));
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