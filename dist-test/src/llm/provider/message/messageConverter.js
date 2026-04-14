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
exports.MessageConverter = void 0;
exports.truncateMiddle = truncateMiddle;
const vscode = __importStar(require("vscode"));
const promises_1 = require("node:fs/promises");
/**
 * Converts VS Code LanguageModelChatRequestMessage objects to the
 * provider-internal LlmMessage format and provides message-content
 * sanitization helpers.
 *
 * Pure I/O — no mutable state except the output channel for diagnostics.
 */
class MessageConverter {
    output;
    static maxToolResultChars = 1400;
    static maxDataPartChars = 6000;
    constructor(output) {
        this.output = output;
    }
    /**
     * Convert a full VS Code message list into Ollama chat messages.
     *
     * Important: VS Code represents tool call results as LanguageModelToolResultPart
     * embedded in a *User* message. If we flatten that into plain text we lose the
     * tool/result linkage and many models will re-call the same tool.
     */
    convertRequestMessages(messages, compactEnvelopeMessages) {
        const result = [];
        const callIdToName = new Map();
        for (const message of messages) {
            const mappedRole = this.mapMessageRole(message.role);
            const textSegments = [];
            const images = [];
            const assistantToolCalls = [];
            const toolResults = [];
            for (const part of message.content) {
                const imageBase64 = this.extractImageBase64(part);
                if (imageBase64) {
                    images.push(imageBase64);
                    continue;
                }
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    const callId = part.callId;
                    const name = part.name;
                    if (callId && name) {
                        callIdToName.set(callId, name);
                    }
                    if (mappedRole === "assistant") {
                        assistantToolCalls.push({
                            id: callId,
                            function: {
                                name,
                                arguments: part.input,
                            },
                        });
                    }
                    continue;
                }
                if (part instanceof vscode.LanguageModelToolResultPart) {
                    const toolContent = part.content
                        .map((resultPart) => resultPart instanceof vscode.LanguageModelTextPart ? resultPart.value : "")
                        .filter((entry) => entry.length > 0)
                        .join("\n");
                    const content = toolContent.length <= MessageConverter.maxToolResultChars
                        ? toolContent
                        : truncateMiddle(toolContent, MessageConverter.maxToolResultChars);
                    toolResults.push({ callId: part.callId, content });
                    continue;
                }
                const text = this.partToText(part).trim();
                if (text.length > 0) {
                    textSegments.push(text);
                }
            }
            const rawContent = textSegments.join("\n").trim();
            const content = compactEnvelopeMessages && mappedRole === "user"
                ? this.compactEnvelopeUserMessage(rawContent)
                : rawContent;
            // 1) Emit the base message (user/assistant) if it has content/images/tool_calls.
            const shouldEmitBaseMessage = content.length > 0 || images.length > 0 || assistantToolCalls.length > 0;
            if (shouldEmitBaseMessage) {
                result.push({
                    role: mappedRole,
                    content,
                    ...(images.length > 0 ? { images } : {}),
                    ...(assistantToolCalls.length > 0 ? { tool_calls: assistantToolCalls } : {}),
                });
            }
            // 2) Emit tool result messages after the carrier user message.
            // VS Code represents tool results as parts on a user message; Ollama expects
            // role=tool messages so the model can incorporate them reliably.
            for (const toolResult of toolResults) {
                const toolName = callIdToName.get(toolResult.callId) ?? "tool";
                result.push({
                    role: "tool",
                    tool_name: toolName,
                    tool_call_id: toolResult.callId,
                    content: toolResult.content,
                });
            }
        }
        return result;
    }
    convertRequestMessage(message, compactEnvelopeMessages) {
        // NOTE: Prefer convertRequestMessages() for full-fidelity conversion.
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
            ...(assistantToolCalls.length > 0 ? { tool_calls: assistantToolCalls } : {}),
        };
    }
    mapMessageRole(role) {
        if (role === vscode.LanguageModelChatMessageRole.Assistant) {
            return "assistant";
        }
        return "user";
    }
    sanitizeCopilotPreambleMessage(content, stripRefusalDirective, stripStyleDirective, compactCopilotPreamble) {
        if (!this.looksLikeCopilotPreamble(content)) {
            return content;
        }
        let result = compactCopilotPreamble ? this.compactCopilotPreambleContent(content) : content;
        if (compactCopilotPreamble) {
            return this.minimizeCopilotPreamble(result);
        }
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
    minimizeCopilotPreamble(content) {
        const primaryUserRequest = this.extractTaggedSection(content, "userRequest")
            .replace(/\s+/g, " ")
            .trim();
        const baseline = [
            "You are GitHub Copilot, a coding assistant running in VS Code.",
            "Follow user requirements carefully.",
            "Follow safety and copyright constraints.",
            "Use tools when needed and provide required tool arguments exactly.",
            "Respond concisely and continue until the task is resolved.",
        ];
        if (primaryUserRequest) {
            baseline.push(`Primary user request: ${primaryUserRequest.slice(0, 1600)}`);
        }
        return baseline.join("\n");
    }
    compactEnvelopeUserMessage(content) {
        const extractedUserRequest = this.extractTaggedSection(content, "userRequest");
        if (extractedUserRequest) {
            const reminder = this.extractTaggedSection(content, "reminderInstructions");
            const context = this.extractTaggedSection(content, "context");
            const parts = [extractedUserRequest.trim()];
            if (context) {
                parts.push(`\nCurrent context:\n${truncateMiddle(context.trim(), 500)}`);
            }
            if (reminder) {
                parts.push(`\nExecution constraints:\n${truncateMiddle(reminder.trim(), 1200)}`);
            }
            return parts.join("\n").trim();
        }
        return content;
    }
    looksLikeCopilotPreamble(content) {
        const normalized = content.toLowerCase();
        return (normalized.includes("you are an expert ai programming assistant, working with a user in the vs code editor") && normalized.includes("follow microsoft content policies"));
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
    partToText(part) {
        if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
        }
        // Preserve non-image LanguageModelDataPart-like payloads.
        // VS Code may represent user-attached context as data parts (text/json).
        // We handle these structurally (mimeType + data/value) to avoid relying on
        // runtime instanceof checks that are hard to reproduce in unit tests.
        if (part && typeof part === "object") {
            const candidate = part;
            const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "";
            if (mimeType && !mimeType.startsWith("image/")) {
                const payload = candidate.data ?? candidate.value;
                const decoded = this.decodeDataPartPayload(payload, mimeType);
                if (decoded) {
                    return decoded.length <= MessageConverter.maxDataPartChars
                        ? decoded
                        : truncateMiddle(decoded, MessageConverter.maxDataPartChars);
                }
            }
        }
        if (part instanceof vscode.LanguageModelToolResultPart) {
            const result = part.content
                .map((resultPart) => resultPart instanceof vscode.LanguageModelTextPart ? resultPart.value : "")
                .filter((entry) => entry.length > 0)
                .join("\n");
            if (result.length <= MessageConverter.maxToolResultChars) {
                return result;
            }
            return truncateMiddle(result, MessageConverter.maxToolResultChars);
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
    decodeDataPartPayload(payload, mimeType) {
        if (!payload)
            return "";
        // Most common: text/* or json encoded as bytes.
        const asUtf8 = this.tryDecodeUtf8(payload);
        if (asUtf8) {
            // Keep JSON readable if possible.
            if (mimeType.includes("json") || mimeType.endsWith("+json")) {
                try {
                    const parsed = JSON.parse(asUtf8);
                    return JSON.stringify(parsed, null, 2);
                }
                catch {
                    return asUtf8;
                }
            }
            return asUtf8;
        }
        // Sometimes json() may carry the object itself.
        if (mimeType.includes("json") || mimeType.endsWith("+json")) {
            try {
                return JSON.stringify(payload, null, 2);
            }
            catch {
                return String(payload);
            }
        }
        if (typeof payload === "string")
            return payload;
        return "";
    }
    tryDecodeUtf8(payload) {
        try {
            if (payload instanceof Uint8Array) {
                return Buffer.from(payload).toString("utf8");
            }
            if (payload instanceof ArrayBuffer) {
                return Buffer.from(new Uint8Array(payload)).toString("utf8");
            }
            if (Array.isArray(payload) && payload.every((entry) => typeof entry === "number")) {
                return Buffer.from(payload).toString("utf8");
            }
            if (payload &&
                typeof payload === "object" &&
                "type" in payload &&
                payload.type === "Buffer" &&
                "data" in payload &&
                Array.isArray(payload.data)) {
                return Buffer.from(payload.data).toString("utf8");
            }
        }
        catch {
            // ignore
        }
        return "";
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
        if (Array.isArray(payload) && payload.every((entry) => typeof entry === "number")) {
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
    isDebugDumpEnabled() {
        return process.env.LOCAL_QWEN_DEBUG_DUMP === "1";
    }
    writeDebugDump(filePath, payload, summary) {
        void (0, promises_1.writeFile)(filePath, payload, "utf8")
            .then(() => {
            this.output.appendLine(`[local-qwen] DEBUG: ${summary} to ${filePath}`);
        })
            .catch(() => {
            // ignore write errors
        });
    }
}
exports.MessageConverter = MessageConverter;
/** Truncate long text by keeping head and tail with an ellipsis in the middle. */
function truncateMiddle(content, maxChars) {
    if (content.length <= maxChars || maxChars < 80) {
        return content.slice(0, Math.max(0, maxChars));
    }
    const head = Math.floor(maxChars * 0.65);
    const tail = Math.max(0, maxChars - head - 48);
    const prefix = content.slice(0, head).trimEnd();
    const suffix = tail > 0 ? content.slice(content.length - tail).trimStart() : "";
    return [prefix, "\n\n...\n\n", suffix].filter((part) => part.length > 0).join("");
}
//# sourceMappingURL=messageConverter.js.map