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
const ollamaVision_1 = require("./ollamaVision");
const streamResponseNativeOnly_1 = require("./provider/streaming/streamResponseNativeOnly");
const systemPrompt_1 = require("./provider/prompt/systemPrompt");
const snapshots_1 = require("./provider/context/snapshots");
const toolSpecBuilder_1 = require("./provider/tools/toolSpecBuilder");
const messageConverter_1 = require("./provider/message/messageConverter");
const modelRegistry_1 = require("./provider/model/modelRegistry");
const outboundLogger_1 = require("./provider/debug/outboundLogger");
const coercion_1 = require("./provider/utils/coercion");
class LocalLanguageModelProvider {
    output;
    static defaultContextLength = 32768;
    static defaultEndpoint = "http://localhost:11434";
    static defaultModel = "qwen2.5:32b";
    static defaultTemperature = 0.2;
    // 80 % of the context window is used for input tokens.  Copilot Chat and
    // other VS Code LM consumers prune context down to maxInputTokens before
    // sending the request, so an overly small ratio causes aggressive pruning and
    // severely degrades agent performance.  0.80 leaves 20 % headroom for
    // generation while keeping the full context available for reading.
    static inputBudgetRatio = 0.8;
    static toolTurnMaxOutputTokens = 1536;
    static runtimeVerificationToolNames = [
        // Generic machine-interaction tool names (when provided by host/runtime)
        "take_screenshot",
        "analyze_image",
        "ocr_find_text",
        "list_windows",
        "focus_window",
        "launch_app",
        "gui_click",
        "gui_type",
        "gui_key",
        "gui_key_hold",
        "gui_scroll",
        "wait_for_condition",
        // Local extension-prefixed aliases registered by this extension
        "localQwen_take_screenshot",
        "localQwen_analyze_image",
        "localQwen_ocr_find_text",
        "localQwen_list_windows",
        "localQwen_focus_window",
        "localQwen_launch_app",
        "localQwen_gui_click",
        "localQwen_gui_type",
        "localQwen_gui_key",
        "localQwen_gui_key_hold",
        "localQwen_gui_scroll",
        "localQwen_wait_for_condition",
    ];
    static workspaceSnapshotCacheTtlMs = 60000;
    static performanceProfiles = {
        quality: {
            name: "quality",
            maxInitialTools: 18,
            maxRequestMessages: 18,
            maxRequestContentChars: 90000,
            maxLatestUserChars: 24000,
            maxPreambleChars: 15000,
            maxIntermediateMessageChars: 9000,
            minDynamicContextTokens: 32768,
            maxDynamicContextTokens: 262144,
            defaultMaxOutputTokens: 4096,
            toolFirstMaxOutputTokens: 1536,
            maxToolDescriptionChars: 320,
        },
        balanced: {
            name: "balanced",
            maxInitialTools: 20,
            maxRequestMessages: 20,
            maxRequestContentChars: 95000,
            maxLatestUserChars: 28000,
            maxPreambleChars: 18000,
            maxIntermediateMessageChars: 10000,
            minDynamicContextTokens: 24576,
            maxDynamicContextTokens: 131072,
            defaultMaxOutputTokens: 3072,
            toolFirstMaxOutputTokens: 1280,
            maxToolDescriptionChars: 320,
        },
        fast: {
            name: "fast",
            maxInitialTools: 8,
            maxRequestMessages: 10,
            maxRequestContentChars: 35000,
            maxLatestUserChars: 11000,
            maxPreambleChars: 8000,
            maxIntermediateMessageChars: 4000,
            minDynamicContextTokens: 16384,
            maxDynamicContextTokens: 65536,
            defaultMaxOutputTokens: 2048,
            toolFirstMaxOutputTokens: 1024,
            maxToolDescriptionChars: 140,
        },
    };
    modelInfoChangedEmitter = new vscode.EventEmitter();
    onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    client = new ollamaClient_1.OllamaClient();
    modelRegistry;
    messageConverter;
    cachedModelInfos;
    inFlightModelInfoRequest;
    activeChatRequests = 0;
    chatWaiters = [];
    toolSpecBuilder = new toolSpecBuilder_1.ToolSpecBuilder();
    cachedWorkspaceSnapshot;
    workspaceFileWatcher;
    /** Per-model capabilities cache — avoids repeated /api/show calls in the same session. */
    modelCapabilitiesCache = new Map();
    constructor(output) {
        this.output = output;
        this.modelRegistry = new modelRegistry_1.ModelRegistry(this.client, this.output);
        this.messageConverter = new messageConverter_1.MessageConverter(this.output);
        // Immediately invalidate the workspace snapshot cache whenever files are
        // created, deleted, or renamed so the next request always sees current state.
        this.workspaceFileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
        const bust = () => {
            this.cachedWorkspaceSnapshot = undefined;
        };
        this.workspaceFileWatcher.onDidCreate(bust);
        this.workspaceFileWatcher.onDidDelete(bust);
    }
    // ---------------------------------------------------------------------------
    // Model discovery
    // ---------------------------------------------------------------------------
    async warmModelInfos() {
        const endpoint = LocalLanguageModelProvider.defaultEndpoint;
        const fallbackModel = LocalLanguageModelProvider.defaultModel;
        try {
            await this.fetchModelInfos(endpoint, fallbackModel);
            this.modelInfoChangedEmitter.fire();
        }
        catch {
            this.modelInfoChangedEmitter.fire();
        }
    }
    invalidateModelInfos() {
        this.cachedModelInfos = undefined;
        this.inFlightModelInfoRequest = undefined;
    }
    dispose() {
        this.modelInfoChangedEmitter.dispose();
        this.workspaceFileWatcher.dispose();
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
    // ---------------------------------------------------------------------------
    // Main request handler — thin translation layer
    // ---------------------------------------------------------------------------
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const performanceProfile = this.getPerformanceProfile();
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const compactCopilotPreamble = configuration.get("compactCopilotPreamble", true);
        const sanitizeCopilotPreamble = configuration.get("sanitizeCopilotPreamble", true);
        const promptMode = configuration.get("promptMode", "guided").trim().toLowerCase();
        const enableWorkspaceSnapshot = configuration.get("enableWorkspaceSnapshot", true);
        const toolsPolicy = configuration.get("toolsPolicy", "enabled").trim().toLowerCase();
        const toolsDisabled = toolsPolicy === "disabled";
        const endpoint = LocalLanguageModelProvider.defaultEndpoint;
        const temperature = LocalLanguageModelProvider.defaultTemperature;
        const timeoutMs = 0;
        const modelContextWindowTokens = model.maxInputTokens + model.maxOutputTokens;
        let contextWindowTokens = modelContextWindowTokens;
        let maxOutputTokens = Math.min(model.maxOutputTokens, performanceProfile.defaultMaxOutputTokens);
        const abortController = this.createAbortController(token);
        await this.acquireChatSlot(1, token);
        try {
            // 1. Convert messages
            let convertedMessages = this.messageConverter.convertRequestMessages(messages, true);
            // 2. Optionally sanitize Copilot preamble
            if (sanitizeCopilotPreamble && convertedMessages.length > 0) {
                const firstMessage = convertedMessages[0];
                const sanitizedFirst = this.messageConverter.sanitizeCopilotPreambleMessage(firstMessage.content, true, true, compactCopilotPreamble);
                if (sanitizedFirst !== firstMessage.content) {
                    firstMessage.content = sanitizedFirst;
                    this.output.appendLine("[local-qwen] sanitized Copilot preamble while preserving tool instructions.");
                }
            }
            // 3. Debug dump of converted messages
            if (this.isDebugDumpEnabled() && convertedMessages.length > 0) {
                const debugPayload = convertedMessages
                    .map((message, index) => {
                    const header = `--- message[${index}] role=${message.role} ---`;
                    return `${header}\n${message.content}`;
                })
                    .join("\n\n");
                this.writeDebugDump("/tmp/copilot-system-prompt-debug.txt", debugPayload, `wrote ${convertedMessages.length} outbound messages`);
            }
            // 4. Convert ALL tools (no subsetting!)
            let tools = toolsDisabled
                ? []
                : this.toOllamaToolSpecs(options.tools ?? [], performanceProfile, true, false);
            if (!toolsDisabled) {
                tools = this.withInjectedRuntimeVerificationTools(tools);
            }
            // 5. Cap output tokens when tools are provided
            if (tools.length > 0) {
                maxOutputTokens = Math.min(maxOutputTokens, LocalLanguageModelProvider.toolTurnMaxOutputTokens);
            }
            // 6. Inject system prompt
            if (promptMode !== "none" && tools.length > 0) {
                const lockedIntent = this.extractLockedIntentFromRawMessages(messages);
                convertedMessages = [
                    {
                        role: "system",
                        content: (0, systemPrompt_1.buildSystemPrompt)({
                            isPackageManagement: this.isExplicitPackageManagementRequest(lockedIntent),
                            lockedIntent,
                            enablePlanningAndChecklists: true,
                        }),
                    },
                    ...convertedMessages,
                ];
            }
            // 7. Optionally inject workspace snapshot
            if (enableWorkspaceSnapshot) {
                const snapshot = await this.getWorkspaceContextSnapshotCached();
                if (snapshot) {
                    // Prepend the snapshot to the LAST user message so the file tree
                    // and open editor contents are in the highest-attention zone.
                    // Many local models deprioritize mid-conversation system messages,
                    // but always fully attend to the user turn they are responding to.
                    const lastUserIdx = convertedMessages.reduce((last, msg, idx) => (msg.role === "user" ? idx : last), -1);
                    if (lastUserIdx >= 0) {
                        const lastUser = convertedMessages[lastUserIdx];
                        convertedMessages = [
                            ...convertedMessages.slice(0, lastUserIdx),
                            { role: "user", content: snapshot + "\n\n" + lastUser.content },
                            ...convertedMessages.slice(lastUserIdx + 1),
                        ];
                    }
                    else {
                        // Fallback: append as a user message
                        convertedMessages.push({ role: "user", content: snapshot });
                    }
                }
            }
            // 8. Vision
            const modelName = model.ollamaName || model.id;
            const modelCapabilities = await this.resolveModelCapabilities(modelName, endpoint, abortController.signal);
            const configuredVisionModel = configuration.get("visionModel", "").trim();
            convertedMessages = await (0, ollamaVision_1.prepareMessagesWithVision)(convertedMessages, modelName, endpoint, this.output, modelCapabilities.supportsVision, configuredVisionModel);
            // 9. Compute dynamic context window
            const messageChars = convertedMessages.reduce((sum, message) => sum + this.estimateMessageSize(message), 0);
            const toolChars = JSON.stringify(tools).length;
            const approxPromptTokens = Math.ceil((messageChars + toolChars) / 4);
            contextWindowTokens = this.computeDynamicContextWindowTokens(modelContextWindowTokens, approxPromptTokens, performanceProfile, maxOutputTokens);
            // 10. Build request
            const request = {
                endpoint,
                model: modelName,
                temperature,
                maxOutputTokens,
                contextWindowTokens,
                keepAlive: "30m",
                messages: convertedMessages,
                tools,
                ...(modelCapabilities.supportsThinking ? { think: true } : {}),
            };
            // 11. Log outbound request
            void (0, outboundLogger_1.appendOutboundOllamaRequestLog)({
                output: this.output,
                source: "lm-provider",
                request: {
                    endpoint: request.endpoint,
                    model: request.model,
                    temperature: request.temperature,
                    maxOutputTokens: request.maxOutputTokens,
                    contextWindowTokens: request.contextWindowTokens,
                    messages: request.messages,
                    tools: request.tools,
                    think: request.think,
                },
            });
            if (this.isDebugDumpEnabled()) {
                this.writeDebugDump("/tmp/copilot-ollama-request-debug.json", JSON.stringify({
                    endpoint,
                    model: request.model,
                    temperature,
                    maxOutputTokens,
                    contextWindowTokens,
                    messages: request.messages,
                    tools: request.tools,
                }, null, 2), `wrote full request payload (tools=${request.tools.length})`);
            }
            this.output.appendLine(`[local-qwen] request(profile=${performanceProfile.name}): messages=${convertedMessages.length}, tools=${tools.length}, ~${approxPromptTokens} prompt tokens, modelMaxInput=${model.maxInputTokens}, num_ctx=${contextWindowTokens}, num_predict=${maxOutputTokens}`);
            // 12. Stream response — NO blocking, NO retry
            await this.streamResponse(request, abortController, timeoutMs, progress);
        }
        finally {
            this.releaseChatSlot();
        }
    }
    // ---------------------------------------------------------------------------
    // Token counting
    // ---------------------------------------------------------------------------
    async provideTokenCount(_model, text, _token) {
        const raw = typeof text === "string" ? text : text.content.map((part) => this.partToText(part)).join(" ");
        return Math.max(1, Math.ceil(raw.length / 4));
    }
    // ---------------------------------------------------------------------------
    // Streaming
    // ---------------------------------------------------------------------------
    /**
     * Stream from Ollama and report text/tool-call parts to Copilot.
     * Thin wrapper around streamResponseNativeOnly with no blocking callbacks.
     */
    async streamResponse(request, abortController, timeoutMs, progress) {
        return (0, streamResponseNativeOnly_1.streamResponseNativeOnly)({
            request,
            client: this.client,
            output: this.output,
            abortController,
            timeoutMs,
            progress,
            streamTextDeltas: true,
            emitTextWhenNoToolCall: true,
            callbacks: {
                parseToolArgs: (toolCall) => this.parseToolArgs(toolCall),
                nextCallId: () => (0, coercion_1.nextCallId)(),
            },
        });
    }
    // ---------------------------------------------------------------------------
    // Model capabilities
    // ---------------------------------------------------------------------------
    /**
     * Fetch and cache what capabilities a model supports (thinking, vision).
     * Uses Ollama's `/api/show` capabilities array; falls back to name heuristics.
     * Results are cached for the session lifetime so repeated requests are free.
     */
    async resolveModelCapabilities(modelName, endpoint, abortSignal) {
        const cached = this.modelCapabilitiesCache.get(modelName);
        if (cached !== undefined) {
            return cached;
        }
        let capabilities;
        try {
            capabilities = await this.client.getModelCapabilities(endpoint, modelName, abortSignal);
        }
        catch {
            // Non-critical — fall through to name heuristic
            capabilities = (0, ollamaClient_1.inferCapabilitiesFromName)(modelName);
        }
        this.output.appendLine(`[local-qwen] model capabilities: ${modelName} → thinking=${capabilities.supportsThinking}, vision=${capabilities.supportsVision}`);
        this.modelCapabilitiesCache.set(modelName, capabilities);
        return capabilities;
    }
    // ---------------------------------------------------------------------------
    // Model registry delegation
    // ---------------------------------------------------------------------------
    async fetchModelInfos(endpoint, fallbackModel) {
        return this.modelRegistry.fetchModelInfos(endpoint, fallbackModel);
    }
    getCachedModelInfos() {
        return this.modelRegistry.getCachedModelInfos();
    }
    // ---------------------------------------------------------------------------
    // Tool spec conversion
    // ---------------------------------------------------------------------------
    /**
     * Convert VS Code tool definitions to Ollama-compatible tool specs.
     * Always sends the full schema — Copilot decides which tools to include.
     */
    toOllamaToolSpecs(tools, performanceProfile, compactSchema, namesOnly) {
        return this.toolSpecBuilder.toOllamaToolSpecs(tools, performanceProfile, compactSchema, namesOnly);
    }
    withInjectedRuntimeVerificationTools(tools) {
        const existingNames = new Set(tools
            .map((tool) => tool.function?.name)
            .filter((name) => typeof name === "string" && name.length > 0));
        const registryByName = new Map(vscode.lm.tools.map((tool) => [tool.name, tool]));
        const injected = LocalLanguageModelProvider.runtimeVerificationToolNames
            .map((name) => registryByName.get(name))
            .filter((tool) => tool !== undefined && !existingNames.has(tool.name))
            .map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema ?? {
                    type: "object",
                    additionalProperties: true,
                },
            },
        }));
        if (injected.length === 0) {
            return [...tools];
        }
        this.output.appendLine(`[local-qwen] injected runtime verification tools: +${injected.length} (${injected
            .map((tool) => tool.function.name)
            .join(", ")})`);
        return [...tools, ...injected];
    }
    // ---------------------------------------------------------------------------
    // Tool argument parsing (JSON parse + type coercion for local models)
    // ---------------------------------------------------------------------------
    parseToolArgs(toolCall) {
        const raw = toolCall.function.arguments;
        let parsed;
        if (typeof raw === "string") {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                this.output.appendLine(`[local-qwen] WARNING: tool '${toolCall.function.name}' arguments are not valid JSON — raw: ${String(raw).slice(0, 120)}`);
                return {};
            }
        }
        else {
            parsed = raw ?? {};
        }
        // Local models (especially Qwen/Llama) often emit Python-style string
        // booleans ("True"/"False") or string numbers ("30") instead of proper
        // JSON types. VS Code validates tool inputs against JSON schemas and
        // rejects these with "must be boolean" / "must be number" errors.
        // Coerce common mismatches so the tool calls succeed.
        const coerced = this.coerceToolArgs(parsed);
        if (coerced !== parsed) {
            this.output.appendLine(`[local-qwen] coerced tool args for '${toolCall.function.name}' (string→boolean/number fixups applied)`);
        }
        return coerced;
    }
    /**
     * Recursively coerce common type mismatches in tool arguments:
     * - String booleans ("True"/"False"/"true"/"false") → real booleans
     * - String integers/floats ("30", "0.5") → real numbers
     *   (only when the string is purely numeric — not paths, queries, etc.)
     */
    coerceToolArgs(args) {
        let changed = false;
        const result = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === "string") {
                const lower = value.toLowerCase();
                if (lower === "true") {
                    result[key] = true;
                    changed = true;
                }
                else if (lower === "false") {
                    result[key] = false;
                    changed = true;
                }
                else if (/^-?\d+$/.test(value) && value.length < 16) {
                    // Pure integer string — coerce to number.
                    // Length guard prevents mangling large IDs or hashes.
                    result[key] = parseInt(value, 10);
                    changed = true;
                }
                else if (/^-?\d+\.\d+$/.test(value) && value.length < 20) {
                    result[key] = parseFloat(value);
                    changed = true;
                }
                else {
                    result[key] = value;
                }
            }
            else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                const inner = this.coerceToolArgs(value);
                result[key] = inner;
                if (inner !== value) {
                    changed = true;
                }
            }
            else {
                result[key] = value;
            }
        }
        return changed ? result : args;
    }
    // ---------------------------------------------------------------------------
    // Context window sizing
    // ---------------------------------------------------------------------------
    computeDynamicContextWindowTokens(modelContextWindowTokens, approxPromptTokens, performanceProfile, maxOutputTokens) {
        // CRITICAL: Ollama's num_ctx is the TOTAL context window (input + output).
        // We must ensure num_ctx >= approxPromptTokens + maxOutputTokens, otherwise
        // the model physically cannot generate its full output budget.
        //
        // Strategy: use the larger of:
        //   (a) prompt + output budget (hard floor)
        //   (b) profile minimum
        // Then cap at the lesser of profile max and model max.
        const outputBudget = maxOutputTokens ?? performanceProfile.defaultMaxOutputTokens;
        const hardFloor = approxPromptTokens + outputBudget;
        const bounded = Math.min(Math.max(hardFloor, performanceProfile.minDynamicContextTokens), performanceProfile.maxDynamicContextTokens, modelContextWindowTokens);
        return bounded;
    }
    // ---------------------------------------------------------------------------
    // Workspace snapshot caching
    // ---------------------------------------------------------------------------
    async getWorkspaceContextSnapshotCached() {
        const cached = this.cachedWorkspaceSnapshot;
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }
        const value = await (0, snapshots_1.buildWorkspaceContextSnapshot)();
        this.cachedWorkspaceSnapshot = {
            expiresAt: Date.now() + LocalLanguageModelProvider.workspaceSnapshotCacheTtlMs,
            value,
        };
        return value;
    }
    // ---------------------------------------------------------------------------
    // Performance profile
    // ---------------------------------------------------------------------------
    getPerformanceProfile() {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const configured = configuration.get("performanceProfile", "balanced");
        if (configured === "quality") {
            return LocalLanguageModelProvider.performanceProfiles.quality;
        }
        if (configured === "fast") {
            return LocalLanguageModelProvider.performanceProfiles.fast;
        }
        return LocalLanguageModelProvider.performanceProfiles.balanced;
    }
    // ---------------------------------------------------------------------------
    // Copilot compatibility mode
    // ---------------------------------------------------------------------------
    isCopilotCompatibilityMode() {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        return configuration.get("copilotCompatibilityMode", true);
    }
    // ---------------------------------------------------------------------------
    // Debug dump
    // ---------------------------------------------------------------------------
    isDebugDumpEnabled() {
        return this.messageConverter.isDebugDumpEnabled();
    }
    writeDebugDump(filePath, payload, summary) {
        this.messageConverter.writeDebugDump(filePath, payload, summary);
    }
    // ---------------------------------------------------------------------------
    // Message helpers
    // ---------------------------------------------------------------------------
    estimateMessageSize(message) {
        let size = (message.content ?? "").length;
        if (message.role) {
            size += message.role.length;
        }
        return size;
    }
    partToText(part) {
        return this.messageConverter.partToText(part);
    }
    // ---------------------------------------------------------------------------
    // Intent extraction (simplified — just finds <userRequest> tag content)
    // ---------------------------------------------------------------------------
    /**
     * Extracts the locked intent text directly from the raw VS Code messages,
     * BEFORE message conversion strips the `<userRequest>` envelope tags.
     *
     * This is the only reliable way to get the actual user request text when
     * Copilot wraps messages in an `<userRequest>...</userRequest>` envelope.
     */
    extractLockedIntentFromRawMessages(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message.role !== vscode.LanguageModelChatMessageRole.User) {
                continue;
            }
            // Collect raw text content from all text parts
            const textParts = [];
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                }
            }
            const rawContent = textParts.join("\n").trim();
            if (!rawContent) {
                continue;
            }
            const tagged = this.messageConverter.extractTaggedSection(rawContent, "userRequest");
            const candidate = (tagged || rawContent).replace(/\s+/g, " ").trim().slice(0, 3000);
            if (candidate) {
                return candidate;
            }
        }
        return "";
    }
    extractLatestRawUserText(messages) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (message.role !== vscode.LanguageModelChatMessageRole.User) {
                continue;
            }
            const textParts = [];
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                }
            }
            const raw = textParts.join("\n").trim();
            if (raw) {
                return raw;
            }
        }
        return "";
    }
    // ---------------------------------------------------------------------------
    // Simple helpers
    // ---------------------------------------------------------------------------
    isExplicitPackageManagementRequest(text) {
        const normalized = text.toLowerCase();
        if (!normalized) {
            return false;
        }
        const mentionsPackageTarget = /\b(package\.json|package-lock(?:\.json)?|dependencies|devdependencies|version|vite|typescript|ts-node|npm|pnpm|yarn)\b/i.test(normalized);
        const hasChangeVerb = /\b(update|upgrade|downgrade|install|remove|add|bump|pin|change|modify|edit)\b/i.test(normalized);
        return mentionsPackageTarget && hasChangeVerb;
    }
    // ---------------------------------------------------------------------------
    // Abort controller
    // ---------------------------------------------------------------------------
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
    // ---------------------------------------------------------------------------
    // Chat slot management
    // ---------------------------------------------------------------------------
    async acquireChatSlot(maxConcurrentRequests, token) {
        const waitStartedAt = Date.now();
        while (this.activeChatRequests >= maxConcurrentRequests) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (Date.now() - waitStartedAt > 30000) {
                this.output.appendLine(`[local-qwen] slot wait exceeded 30s (active=${this.activeChatRequests}, max=${maxConcurrentRequests}); forcing slot recovery.`);
                this.activeChatRequests = 0;
                while (this.chatWaiters.length > 0) {
                    this.chatWaiters.shift()?.();
                }
                break;
            }
            await new Promise((resolve, reject) => {
                let releaseWaiter;
                const disposeCancellation = token.onCancellationRequested(() => {
                    const index = releaseWaiter ? this.chatWaiters.indexOf(releaseWaiter) : -1;
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
        this.output.appendLine(`[local-qwen] acquired chat slot (active=${this.activeChatRequests}/${maxConcurrentRequests})`);
    }
    releaseChatSlot() {
        this.activeChatRequests = Math.max(0, this.activeChatRequests - 1);
        this.output.appendLine(`[local-qwen] released chat slot (active=${this.activeChatRequests})`);
        const waiter = this.chatWaiters.shift();
        waiter?.();
    }
}
exports.LocalLanguageModelProvider = LocalLanguageModelProvider;
//# sourceMappingURL=localLanguageModelProvider.js.map