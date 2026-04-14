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
exports.streamResponseNativeOnly = streamResponseNativeOnly;
const vscode = __importStar(require("vscode"));
async function streamResponseNativeOnly(params) {
    const { request, client, output, abortController, timeoutMs, progress, streamTextDeltas, emitTextWhenNoToolCall, callbacks, } = params;
    let fullContent = "";
    let nativeToolCalls = [];
    const nativeToolFingerprints = new Set();
    let streamed = false;
    const startedAt = Date.now();
    let sawFirstChunk = false;
    let chunkCount = 0;
    const usedToolNames = new Set();
    const stableStringify = (value) => {
        const seen = new WeakSet();
        const normalize = (input) => {
            if (input === null || typeof input !== "object") {
                return input;
            }
            if (seen.has(input)) {
                return "[Circular]";
            }
            seen.add(input);
            if (Array.isArray(input)) {
                return input.map((entry) => normalize(entry));
            }
            const entries = Object.entries(input).sort((a, b) => a[0].localeCompare(b[0]));
            const out = {};
            for (const [k, v] of entries) {
                out[k] = normalize(v);
            }
            return out;
        };
        try {
            return JSON.stringify(normalize(value));
        }
        catch {
            return JSON.stringify(String(value));
        }
    };
    try {
        output.appendLine(`[local-qwen] opening stream request for '${request.model}'...`);
        const { stream } = await client.chatStream(request, abortController.signal, timeoutMs);
        output.appendLine(`[local-qwen] stream opened for '${request.model}' after ${Date.now() - startedAt}ms`);
        streamed = true;
        for await (const chunk of stream) {
            chunkCount += 1;
            if (!sawFirstChunk) {
                sawFirstChunk = true;
                output.appendLine(`[local-qwen] first stream chunk after ${Date.now() - startedAt}ms`);
            }
            const delta = chunk.message.content ?? "";
            if (delta.length > 0) {
                fullContent += delta;
                if (streamTextDeltas) {
                    progress.report(new vscode.LanguageModelTextPart(delta));
                }
            }
            if (chunk.message.tool_calls?.length) {
                for (const toolCall of chunk.message.tool_calls) {
                    const fingerprint = stableStringify({
                        name: toolCall.function?.name,
                        arguments: toolCall.function?.arguments ?? {},
                    });
                    if (nativeToolFingerprints.has(fingerprint)) {
                        continue;
                    }
                    nativeToolFingerprints.add(fingerprint);
                    nativeToolCalls.push(toolCall);
                }
            }
        }
        output.appendLine(`[local-qwen] stream completed in ${Date.now() - startedAt}ms with ${chunkCount} chunk(s), textChars=${fullContent.length}, nativeToolCalls=${nativeToolCalls.length}`);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        output.appendLine(`[local-qwen] stream failed after ${Date.now() - startedAt}ms: ${detail}`);
        throw error;
    }
    if (!streamed && streamTextDeltas && fullContent.trim().length > 0) {
        progress.report(new vscode.LanguageModelTextPart(fullContent));
    }
    // Native tool calls only. Text-based tool-call recovery is intentionally disabled.
    if (nativeToolCalls.length > 0) {
        const toolNames = nativeToolCalls
            .map((tc) => {
            const cmd = tc.function.name === "run_in_terminal"
                ? ` '${String(tc.function.arguments?.command ?? "").slice(0, 60)}'`
                : "";
            return `${tc.function.name}${cmd}`;
        })
            .join(", ");
        if (toolNames) {
            output.appendLine(`[local-qwen] dispatching: ${toolNames}`);
        }
        let emittedNativeToolCallCount = 0;
        for (const toolCall of nativeToolCalls) {
            // Guard: if the raw arguments are a non-empty string that cannot be
            // parsed as JSON, skip the call instead of executing with wrong args.
            const rawArgs = toolCall.function.arguments;
            if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
                let argParseOk = true;
                try {
                    JSON.parse(rawArgs);
                }
                catch {
                    argParseOk = false;
                }
                if (!argParseOk) {
                    output.appendLine(`[local-qwen] skipping tool call '${toolCall.function.name}': arguments contain invalid JSON — raw: ${rawArgs.slice(0, 80)}`);
                    progress.report(new vscode.LanguageModelTextPart(`[Tool call skipped] '${toolCall.function.name}' returned unparseable JSON arguments.`));
                    continue;
                }
            }
            const toolInput = callbacks.parseToolArgs(toolCall);
            usedToolNames.add(toolCall.function.name);
            progress.report(new vscode.LanguageModelToolCallPart(toolCall.id ?? callbacks.nextCallId(), toolCall.function.name, toolInput));
            emittedNativeToolCallCount += 1;
        }
        if (emittedNativeToolCallCount > 0) {
            return {
                emittedToolCalls: true,
                fullContentLength: fullContent.length,
                usedToolNames: [...usedToolNames],
            };
        }
    }
    if (fullContent.trim().length > 0 && emitTextWhenNoToolCall && !streamTextDeltas) {
        progress.report(new vscode.LanguageModelTextPart(fullContent));
    }
    return {
        emittedToolCalls: false,
        fullContentLength: fullContent.length,
        usedToolNames: [...usedToolNames],
    };
}
//# sourceMappingURL=streamResponseNativeOnly.js.map