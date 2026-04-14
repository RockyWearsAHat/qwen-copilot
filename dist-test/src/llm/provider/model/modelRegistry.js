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
exports.ModelRegistry = void 0;
const vscode = __importStar(require("vscode"));
const defaultContextLength = 32768;
const inputBudgetRatio = 0.8;
const defaultModelListTimeoutMs = 7000;
const defaultModelListCacheTtlMs = 30000;
/**
 * Manages discovery and caching of models available via the local Ollama
 * endpoint.  Safe to construct once per extension activation lifetime.
 */
class ModelRegistry {
    client;
    output;
    cachedModelInfos;
    inFlightModelInfoRequest;
    constructor(client, output) {
        this.client = client;
        this.output = output;
    }
    async warmModelInfos(endpoint, fallbackModel) {
        try {
            await this.fetchModelInfos(endpoint, fallbackModel);
        }
        catch {
            // Swallow — callers fire the changed emitter regardless
        }
    }
    invalidate() {
        this.cachedModelInfos = undefined;
        this.inFlightModelInfoRequest = undefined;
    }
    async provideModelInfos(endpoint, fallbackModel, token) {
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
    async fetchModelInfos(endpoint, fallbackModel) {
        const controller = new AbortController();
        try {
            const models = await this.client.listModels(endpoint, controller.signal, defaultModelListTimeoutMs);
            const modelsWithContext = await this.hydrateMissingContextLengths(models, endpoint, controller.signal, defaultModelListTimeoutMs);
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
                expiresAt: Date.now() + Math.max(1000, defaultModelListCacheTtlMs),
                infos,
            };
            return infos;
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[local-qwen] model listing failed: ${text}`);
            const fallbackInfos = [this.createFallbackInfo(fallbackModel)];
            this.cachedModelInfos = {
                expiresAt: Date.now() + Math.max(1000, defaultModelListCacheTtlMs),
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
    /**
     * Compute the maxInputTokens and maxOutputTokens to advertise to Copilot.
     *
     * Local LLMs need generous output windows for reasoning + tool call payloads.
     * We split the context window using inputBudgetRatio to maximise the model's
     * ability to produce complete, batched tool calls.
     */
    getAdvertisedTokenCaps(modelDetails) {
        const contextLength = this.extractModelContextLength(modelDetails) ?? defaultContextLength;
        const maxInputTokens = Math.floor(contextLength * inputBudgetRatio);
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
        const contextLength = modelDetails.context_length;
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
}
exports.ModelRegistry = ModelRegistry;
//# sourceMappingURL=modelRegistry.js.map