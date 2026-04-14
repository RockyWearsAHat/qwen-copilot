"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTaggedTextToolCalls = extractTaggedTextToolCalls;
exports.buildTextToolCallProtocolHint = buildTextToolCallProtocolHint;
const TOOL_CALL_TAG = "local_qwen_tool_call";
function toToolCallFromStructuredPayload(payload, nextId) {
    if (!payload || typeof payload !== "object") {
        return undefined;
    }
    const candidate = payload;
    const functionName = typeof candidate.function?.name === "string"
        ? String(candidate.function.name).trim()
        : typeof candidate.name === "string"
            ? String(candidate.name).trim()
            : "";
    if (!functionName) {
        return undefined;
    }
    const rawArgs = candidate.function?.arguments ??
        candidate.arguments ??
        candidate.input;
    const normalizedArgs = typeof rawArgs === "string" ||
        (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
        ? rawArgs
        : {};
    return {
        id: nextId(),
        function: {
            name: functionName,
            arguments: normalizedArgs,
        },
    };
}
function toToolCallsFromStructuredPayload(payload, nextId) {
    if (!payload) {
        return [];
    }
    // Accept { tool_calls: [...] }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const toolCalls = payload.tool_calls;
        if (Array.isArray(toolCalls)) {
            return toolCalls
                .map((entry) => toToolCallFromStructuredPayload(entry, nextId))
                .filter((entry) => Boolean(entry));
        }
    }
    if (Array.isArray(payload)) {
        return payload
            .map((entry) => toToolCallFromStructuredPayload(entry, nextId))
            .filter((entry) => Boolean(entry));
    }
    const single = toToolCallFromStructuredPayload(payload, nextId);
    return single ? [single] : [];
}
function extractTaggedTextToolCalls(params) {
    const { content, allowedToolNames, nextId } = params;
    void allowedToolNames;
    const expression = new RegExp(`<${TOOL_CALL_TAG}>([\\s\\S]*?)<\\/${TOOL_CALL_TAG}>`, "gi");
    const matches = Array.from(content.matchAll(expression));
    if (matches.length === 0) {
        return { cleanedContent: content, toolCalls: [] };
    }
    const extracted = [];
    for (const match of matches) {
        const payloadText = match[1]?.trim();
        if (!payloadText) {
            continue;
        }
        try {
            const parsed = JSON.parse(payloadText);
            const toolCalls = toToolCallsFromStructuredPayload(parsed, nextId);
            for (const toolCall of toolCalls) {
                extracted.push(toolCall);
            }
        }
        catch {
            continue;
        }
    }
    const cleaned = content.replace(expression, "").trim();
    return { cleanedContent: cleaned, toolCalls: extracted };
}
function buildTextToolCallProtocolHint(toolNames) {
    const listed = toolNames.slice(0, 40).join(", ");
    return [
        "## Tool-call fallback (for models without native tool_calls)",
        "If you need to use tools, prefer outputting a single tagged JSON block:",
        `<${TOOL_CALL_TAG}>{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{...}}]}</${TOOL_CALL_TAG}>`,
        "Extra prose is allowed, but keeping it minimal reduces parsing ambiguity.",
        listed ? `Allowed tools this turn: ${listed}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}
//# sourceMappingURL=textToolCallBridge.js.map