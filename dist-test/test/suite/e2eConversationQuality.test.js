"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const ollamaClient_1 = require("../../src/llm/ollamaClient");
function toNumber(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}
function extractFirstJsonObject(text) {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [trimmed, fenced?.[1] ?? ""];
    for (const candidate of candidates) {
        const source = candidate.trim();
        if (!source) {
            continue;
        }
        try {
            const direct = JSON.parse(source);
            if (direct && typeof direct === "object" && !Array.isArray(direct)) {
                return direct;
            }
        }
        catch {
            // Try extracting first {...} block.
        }
        const objectMatch = source.match(/\{[\s\S]*\}/);
        if (!objectMatch) {
            continue;
        }
        try {
            const parsed = JSON.parse(objectMatch[0]);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            continue;
        }
    }
    return undefined;
}
async function streamConversation(client, endpoint, model, messages, tools, temperature) {
    const startedAt = Date.now();
    let firstTokenMs = -1;
    let fullText = "";
    let toolCallCount = 0;
    const toolCallSummaries = [];
    const response = await client.chatStream({
        endpoint,
        model,
        messages,
        tools,
        temperature,
        maxOutputTokens: 1536,
        contextWindowTokens: 32768,
    }, new AbortController().signal, 0);
    for await (const chunk of response.stream) {
        const delta = chunk.message.content ?? "";
        if (delta.length > 0 && firstTokenMs < 0) {
            firstTokenMs = Date.now() - startedAt;
        }
        fullText += delta;
        if (Array.isArray(chunk.message.tool_calls)) {
            toolCallCount += chunk.message.tool_calls.length;
            if (chunk.message.tool_calls.length > 0 && firstTokenMs < 0) {
                firstTokenMs = Date.now() - startedAt;
            }
            for (const toolCall of chunk.message.tool_calls) {
                const args = typeof toolCall.function.arguments === "string"
                    ? toolCall.function.arguments
                    : JSON.stringify(toolCall.function.arguments ?? {});
                toolCallSummaries.push(`${toolCall.function.name}(${args})`);
            }
        }
    }
    const trimmedText = fullText.trim();
    const gradingTranscript = trimmedText.length > 0
        ? trimmedText
        : toolCallSummaries.length > 0
            ? `Model emitted tool calls without prose:\n${toolCallSummaries.join("\n")}`
            : "";
    return {
        fullText: trimmedText,
        gradingTranscript,
        elapsedMs: Date.now() - startedAt,
        firstTokenMs,
        toolCallCount,
    };
}
async function scoreConversationWithQwen(client, endpoint, graderModel, userRequest, transcript) {
    const rubricPrompt = [
        "You are grading a coding-assistant conversation.",
        "Score strictly from 0 to 10 for each category:",
        "- repetitiveness (higher is less repetitive)",
        "- requestAlignment (tracks user's original request)",
        "- stepEfficiency (minimal unnecessary steps)",
        "- readability (easy to follow)",
        "- simplicity (avoids confusion)",
        "- overall",
        "Return ONLY JSON with keys:",
        "repetitiveness, requestAlignment, stepEfficiency, readability, simplicity, overall, verdict, notes",
        "Where verdict is exactly good or bad; notes is array of short strings.",
        `User request: ${userRequest}`,
        "Assistant transcript:",
        transcript.slice(0, 12000),
    ].join("\n");
    const result = await client.chat({
        endpoint,
        model: graderModel,
        temperature: 0,
        tools: [],
        messages: [{ role: "user", content: rubricPrompt }],
        maxOutputTokens: 512,
        contextWindowTokens: 8192,
    }, new AbortController().signal, 0);
    const raw = result.message.content ?? "";
    const parsed = extractFirstJsonObject(raw);
    strict_1.default.ok(parsed, `grader did not return parseable JSON: ${raw.slice(0, 500)}`);
    const notes = Array.isArray(parsed?.notes)
        ? parsed.notes.filter((entry) => typeof entry === "string")
        : [];
    const verdict = parsed?.verdict === "good" ? "good" : "bad";
    return {
        repetitiveness: toNumber(parsed?.repetitiveness, 0),
        requestAlignment: toNumber(parsed?.requestAlignment, 0),
        stepEfficiency: toNumber(parsed?.stepEfficiency, 0),
        readability: toNumber(parsed?.readability, 0),
        simplicity: toNumber(parsed?.simplicity, 0),
        overall: toNumber(parsed?.overall, 0),
        verdict,
        notes,
    };
}
suite("E2E conversation quality (opt-in)", function () {
    this.timeout(300000);
    const runE2E = process.env.LOCAL_QWEN_E2E === "1";
    const endpoint = process.env.LOCAL_QWEN_E2E_ENDPOINT ?? "http://localhost:11434";
    const model = process.env.LOCAL_QWEN_E2E_MODEL ?? "qwen3-coder:30b-256k";
    const graderModel = process.env.LOCAL_QWEN_E2E_GRADER_MODEL ?? model;
    const maxFirstTokenMs = toNumber(process.env.LOCAL_QWEN_E2E_MAX_FIRST_TOKEN_MS, 20000);
    const maxTotalMs = toNumber(process.env.LOCAL_QWEN_E2E_MAX_TOTAL_MS, 120000);
    const minOverall = toNumber(process.env.LOCAL_QWEN_E2E_MIN_OVERALL, 7);
    const isolatedWorkspace = "/tmp/local-qwen-e2e-quality-env";
    const forbiddenWorkspace = "/Users/alexwaldmann/anthropic-copilot/testEnv";
    const toolset = [
        {
            type: "function",
            function: {
                name: "create_new_workspace",
                description: "Create a new project workspace in VS Code.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                    },
                    required: ["query"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "read_file",
                description: "Read file contents.",
                parameters: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        startLine: { type: "number" },
                        endLine: { type: "number" },
                    },
                    required: ["filePath", "startLine", "endLine"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "replace_in_files",
                description: "Replace text across files in one operation.",
                parameters: {
                    type: "object",
                    properties: {
                        from: { type: "string" },
                        to: { type: "string" },
                    },
                    required: ["from", "to"],
                },
            },
        },
    ];
    const client = new ollamaClient_1.OllamaClient();
    (runE2E ? test : test.skip)("full-generation speed and readability meet quality threshold", async () => {
        const userRequest = [
            `Start a new Vite project in ${isolatedWorkspace}.`,
            "Keep the plan concise.",
            "Avoid repetitive narration.",
            "Use simple, direct steps.",
        ].join(" ");
        const result = await streamConversation(client, endpoint, model, [
            {
                role: "system",
                content: "You are a coding agent. Stay concise, avoid repetition, and focus on user intent.",
            },
            { role: "user", content: userRequest },
        ], toolset, 0.2);
        strict_1.default.ok(result.firstTokenMs >= 0, "expected first token to be observed");
        strict_1.default.ok(result.fullText.length > 0 || result.toolCallCount > 0, "expected either prose or tool calls from streamed generation");
        strict_1.default.ok(result.firstTokenMs <= maxFirstTokenMs, `first token too slow: ${result.firstTokenMs}ms > ${maxFirstTokenMs}ms`);
        strict_1.default.ok(result.elapsedMs <= maxTotalMs, `total response too slow: ${result.elapsedMs}ms > ${maxTotalMs}ms`);
        strict_1.default.equal(result.fullText.includes(forbiddenWorkspace), false);
        const score = await scoreConversationWithQwen(client, endpoint, graderModel, userRequest, result.gradingTranscript);
        strict_1.default.ok(score.overall >= minOverall, `overall score too low (${score.overall} < ${minOverall}) notes=${score.notes.join(" | ")}`);
        strict_1.default.equal(score.verdict, "good", `verdict=${score.verdict}, notes=${score.notes.join(" | ")}`);
    });
    (runE2E ? test : test.skip)("intent persistence across long noisy transcript remains aligned", async () => {
        const intentMessage = "Instead of /assets/level1.json, use /level1.json everywhere in the project.";
        const userRequest = `${intentMessage} Continue the same replacement intent; do not restart or drift.`;
        const result = await streamConversation(client, endpoint, model, [
            {
                role: "system",
                content: "You are a coding agent. Persist the initial user intent across turns and tool noise.",
            },
            { role: "user", content: intentMessage },
            {
                role: "assistant",
                content: "Running read_file. Running list_dir. I found unrelated files and will continue exploring.",
            },
            {
                role: "user",
                content: "Tool result noise: read_file output, search output, and unrelated file listings.",
            },
            { role: "user", content: userRequest },
        ], toolset, 0.2);
        strict_1.default.ok(result.fullText.length > 0 || result.toolCallCount > 0, "expected either prose or tool calls from streamed generation");
        const lower = result.gradingTranscript.toLowerCase();
        strict_1.default.ok(lower.includes("/level1.json") || lower.includes("level1.json"), `expected persisted replacement target in response: ${result.gradingTranscript.slice(0, 600)}`);
        const score = await scoreConversationWithQwen(client, endpoint, graderModel, userRequest, result.gradingTranscript);
        strict_1.default.ok(score.requestAlignment >= minOverall, `intent alignment too low (${score.requestAlignment} < ${minOverall}) notes=${score.notes.join(" | ")}`);
        strict_1.default.ok(score.stepEfficiency >= minOverall - 1, `step efficiency too low (${score.stepEfficiency}) notes=${score.notes.join(" | ")}`);
        strict_1.default.equal(score.verdict, "good", `verdict=${score.verdict}, notes=${score.notes.join(" | ")}`);
    });
});
//# sourceMappingURL=e2eConversationQuality.test.js.map