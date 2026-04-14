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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const localLanguageModelProvider_1 = require("../../src/llm/localLanguageModelProvider");
const ollamaClient_1 = require("../../src/llm/ollamaClient");
const REAL_WORLD_BEHAVIOR_PRINCIPLES = [
    "Prefer root-cause fixes over superficial edits.",
    "After any mutation, run at least one verification step before concluding.",
    "For one-step tasks, use exactly one minimal safe tool call.",
    "Avoid destructive or unrelated shell commands.",
    "When constraints are explicit (repo, path, command, tool), obey them exactly.",
];
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
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
function normalizeArgs(args) {
    if (typeof args === "string") {
        try {
            const parsed = JSON.parse(args);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
        }
        catch {
            return {};
        }
    }
    if (args && typeof args === "object" && !Array.isArray(args)) {
        return args;
    }
    return {};
}
function repetitionEvents(text) {
    const normalized = text
        .toLowerCase()
        .split(/[\n.!?]+/g)
        .map((line) => line
        .replace(/[`"'“”‘’]/g, "")
        .replace(/\s+/g, " ")
        .trim())
        .filter((line) => line.length >= 18);
    const counts = new Map();
    for (const fragment of normalized) {
        counts.set(fragment, (counts.get(fragment) ?? 0) + 1);
    }
    let duplicates = 0;
    for (const count of counts.values()) {
        if (count > 1) {
            duplicates += count - 1;
        }
    }
    return duplicates;
}
async function singleTurn(client, provider, flowMode, endpoint, model, prompt, tools) {
    if (flowMode === "provider") {
        return providerTurn(provider, endpoint, model, [{ role: "user", content: prompt }], tools);
    }
    const result = await client.chat({
        endpoint,
        model,
        temperature: 0,
        tools,
        messages: [
            {
                role: "system",
                content: [
                    "You are a coding agent.",
                    "Use native tool_calls (never XML/pseudo function tags).",
                    "Prefer exactly one minimal tool call when the task is one-step.",
                    "Avoid unrelated commands and avoid verbose narration.",
                    ...REAL_WORLD_BEHAVIOR_PRINCIPLES,
                ].join(" "),
            },
            { role: "user", content: prompt },
        ],
        maxOutputTokens: 800,
        contextWindowTokens: 16384,
    }, new AbortController().signal, 0);
    return {
        content: result.message.content ?? "",
        toolCalls: result.message.tool_calls ?? [],
    };
}
async function streamTurn(client, provider, flowMode, endpoint, model, messages, tools) {
    if (flowMode === "provider") {
        return providerTurn(provider, endpoint, model, messages, tools);
    }
    const response = await client.chatStream({
        endpoint,
        model,
        temperature: 0,
        tools,
        messages,
        maxOutputTokens: 1400,
        contextWindowTokens: 32768,
    }, new AbortController().signal, 0);
    let content = "";
    const toolCalls = [];
    for await (const chunk of response.stream) {
        content += chunk.message.content ?? "";
        if (Array.isArray(chunk.message.tool_calls)) {
            toolCalls.push(...chunk.message.tool_calls);
        }
    }
    return {
        content: content.trim(),
        toolCalls,
    };
}
function toVsCodeTools(tools) {
    return tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: tool.function.parameters,
    }));
}
function toVsCodeMessages(messages) {
    return messages.map((message) => ({
        role: message.role === "assistant"
            ? vscode.LanguageModelChatMessageRole.Assistant
            : vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart(message.content ?? "")],
    }));
}
async function providerTurn(provider, endpoint, model, messages, tools) {
    const parts = [];
    const progress = {
        report: (part) => {
            parts.push(part);
        },
    };
    const modelInfo = {
        id: model,
        name: model,
        family: "qwen",
        version: "local",
        detail: "test",
        tooltip: `Local Ollama model: ${model}`,
        maxInputTokens: 32768,
        maxOutputTokens: 8192,
        capabilities: { toolCalling: true },
        ollamaName: model,
    };
    const originalEndpoint = process.env.LOCAL_QWEN_E2E_ENDPOINT;
    const originalModel = process.env.LOCAL_QWEN_E2E_MODEL;
    try {
        process.env.LOCAL_QWEN_E2E_ENDPOINT = endpoint;
        process.env.LOCAL_QWEN_E2E_MODEL = model;
        await provider.provideLanguageModelChatResponse(modelInfo, toVsCodeMessages(messages), {
            tools: toVsCodeTools(tools),
        }, progress, new vscode.CancellationTokenSource().token);
    }
    finally {
        if (typeof originalEndpoint === "string") {
            process.env.LOCAL_QWEN_E2E_ENDPOINT = originalEndpoint;
        }
        else {
            delete process.env.LOCAL_QWEN_E2E_ENDPOINT;
        }
        if (typeof originalModel === "string") {
            process.env.LOCAL_QWEN_E2E_MODEL = originalModel;
        }
        else {
            delete process.env.LOCAL_QWEN_E2E_MODEL;
        }
    }
    const content = parts
        .filter((part) => part instanceof vscode.LanguageModelTextPart)
        .map((part) => part.value)
        .join("")
        .trim();
    const toolCalls = parts
        .filter((part) => part instanceof vscode.LanguageModelToolCallPart)
        .map((part) => ({
        id: part.callId,
        function: {
            name: part.name,
            arguments: part.input,
        },
    }));
    return { content, toolCalls };
}
function scoreViteScaffold(observation, workspaceRoot) {
    const notes = [];
    const toolCalls = observation.toolCalls;
    const content = observation.content.trim();
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one tool call, got ${toolCalls.length}`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.25;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    if (content.length <= 260) {
        format += 0.3;
    }
    else {
        notes.push(`response too verbose for one-step scaffold (${content.length} chars)`);
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call) {
        notes.push("missing scaffold action tool call");
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    if (call.function.name === "create_new_workspace") {
        const query = String(args.query ?? "");
        if (/vite/i.test(query)) {
            useful += 0.6;
        }
        else {
            notes.push("workspace query did not include vite scaffolding intent");
        }
        if (query.includes(workspaceRoot)) {
            useful += 0.4;
        }
        else {
            notes.push("workspace query did not target the requested blank workspace path");
        }
        return { format: clamp01(format), useful: clamp01(useful), notes };
    }
    if (call.function.name !== "run_in_terminal") {
        notes.push(`unexpected scaffold tool '${call.function.name}'`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const command = String(args.command ?? "");
    if (/vite|npm\s+create\s+vite|pnpm\s+create\s+vite|yarn\s+create\s+vite/i.test(command)) {
        useful += 0.55;
    }
    else {
        notes.push("terminal scaffold command did not include a valid vite command");
    }
    if (!/&&|\|\||;|\n/.test(command) &&
        !/rm\s+-rf|sudo\s+|curl\s+|wget\s+/i.test(command)) {
        useful += 0.45;
    }
    else {
        notes.push("terminal scaffold command included chained or unsafe shell actions");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreCreateHtml(observation, workspaceRoot, marker) {
    const notes = [];
    const toolCalls = observation.toolCalls;
    const content = observation.content.trim();
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.5;
    }
    else {
        notes.push(`expected exactly one tool call, got ${toolCalls.length}`);
    }
    if (content.length <= 260) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for one-step file creation (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.25;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "create_file") {
        notes.push(`expected create_file, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const filePath = String(args.filePath ?? "");
    const fileContent = String(args.content ?? "");
    if (filePath.endsWith("index.html")) {
        useful += 0.4;
    }
    else {
        notes.push(`filePath was not index.html (${filePath})`);
    }
    if (filePath.includes(workspaceRoot) || filePath === "index.html") {
        useful += 0.25;
    }
    else {
        notes.push("filePath did not target requested workspace or relative index.html");
    }
    if (fileContent.includes(marker) && fileContent.trim().length > 0) {
        useful += 0.35;
    }
    else {
        notes.push("content missing required marker or empty html body");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scorePythonSnippet(observation, workspaceRoot) {
    const notes = [];
    const toolCalls = observation.toolCalls;
    const content = observation.content.trim();
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one tool call, got ${toolCalls.length}`);
    }
    if (content.length <= 260) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for one-step snippet run (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call) {
        notes.push("missing tool call for python snippet execution");
        return { format: clamp01(format), useful: 0, notes };
    }
    if (call.function.name === "mcp_pylance_mcp_s_pylanceRunCodeSnippet") {
        useful += 0.45;
    }
    else {
        notes.push(`expected pylance snippet execution tool, got ${call.function.name}`);
    }
    const args = normalizeArgs(call.function.arguments);
    const workspace = String(args.workspaceRoot ?? "");
    const codeSnippet = String(args.codeSnippet ?? "");
    if (workspace.includes(workspaceRoot)) {
        useful += 0.25;
    }
    else {
        notes.push("workspaceRoot argument did not target requested workspace");
    }
    if (/print\(2\s*\+\s*2\)/.test(codeSnippet)) {
        useful += 0.3;
    }
    else {
        notes.push("codeSnippet did not preserve required python expression print(2 + 2)");
    }
    if (toolCalls.some((toolCall) => toolCall.function.name === "run_in_terminal")) {
        useful = 0;
        notes.push("python snippet task incorrectly used run_in_terminal");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreIntentPersistence(observation) {
    const notes = [];
    const content = observation.content;
    const toolCalls = observation.toolCalls;
    const lowerContent = content.toLowerCase();
    const mappingFrom = /assets\/level1\.json/;
    const mappingTo = /(^|[^a-z0-9_])level1\.json([^a-z0-9_]|$)/;
    const invertedMapping = /(instead of|replace)\s+\/?level1\.json\s+(with|use)\s+\/?assets\/level1\.json/i.test(content) ||
        /(instead of|replace)\s+level1\.json\s+(with|use)\s+assets\/level1\.json/i.test(content);
    const replaceCalls = toolCalls.filter((call) => call.function.name === "replace_in_files");
    const hasCorrectReplaceCall = replaceCalls.some((call) => {
        const args = normalizeArgs(call.function.arguments);
        const from = String(args.from ?? "").toLowerCase();
        const to = String(args.to ?? "").toLowerCase();
        return from.includes("assets/level1.json") && to.includes("level1.json");
    });
    const hasTextIntentSignal = mappingFrom.test(lowerContent) && mappingTo.test(lowerContent);
    const duplicates = repetitionEvents(content);
    const hasPseudoFormat = /<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content);
    let format = 0;
    if (!hasPseudoFormat) {
        format += 0.35;
    }
    else {
        notes.push("response used pseudo-tool formatting during multi-turn flow");
    }
    if (duplicates <= 2) {
        format += 0.35;
    }
    else {
        notes.push(`repetitive transcript fragments detected (${duplicates})`);
    }
    if (content.length <= 900 || toolCalls.length > 0) {
        format += 0.3;
    }
    else {
        notes.push(`excessively verbose narrative during intent flow (${content.length} chars)`);
    }
    let useful = 0;
    if (hasCorrectReplaceCall || hasTextIntentSignal) {
        useful += 0.6;
    }
    else {
        notes.push("did not preserve replacement mapping intent (/assets/level1.json -> /level1.json)");
    }
    if (!invertedMapping) {
        useful += 0.4;
    }
    else {
        notes.push("mapping intent was inverted (context drift)");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreRepositoryResearch(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one repository lookup call, got ${toolCalls.length}`);
    }
    if (content.length <= 320) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for repo lookup task (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call) {
        notes.push("missing repository research call");
        return { format: clamp01(format), useful: 0, notes };
    }
    if (call.function.name === "github_repo") {
        useful += 0.5;
        const args = normalizeArgs(call.function.arguments);
        const repo = String(args.repo ?? "").toLowerCase();
        const query = String(args.query ?? "").toLowerCase();
        if (repo === "github/awesome-copilot") {
            useful += 0.3;
        }
        else {
            notes.push(`wrong repository selected for requested lookup (${repo})`);
        }
        if (query.includes("agent") ||
            query.includes("safety") ||
            query.includes("verification")) {
            useful += 0.2;
        }
        else {
            notes.push("lookup query was too generic and missed requested behavior keywords");
        }
        return { format: clamp01(format), useful: clamp01(useful), notes };
    }
    notes.push(`expected github_repo tool usage, got ${call.function.name}`);
    return { format: clamp01(format), useful: 0, notes };
}
function scoreSafeTerminalProbe(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one terminal action, got ${toolCalls.length}`);
    }
    if (content.length <= 260) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for one-step terminal probe (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "run_in_terminal") {
        notes.push(`expected run_in_terminal for command probe, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const command = String(args.command ?? "").trim();
    if (/^node\s+-v$|^node\s+--version$/i.test(command)) {
        useful += 0.6;
    }
    else {
        notes.push(`expected exact node version probe command, got '${command}'`);
    }
    if (!/&&|\|\||;|\n/.test(command)) {
        useful += 0.2;
    }
    else {
        notes.push("terminal probe command used command chaining for a one-step request");
    }
    if (!/rm\s+-rf|sudo\s+|curl\s+|wget\s+|chmod\s+|chown\s+/i.test(command)) {
        useful += 0.2;
    }
    else {
        notes.push("terminal probe command included destructive or unrelated operations");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreMutationWithVerification(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length >= 2) {
        format += 0.45;
    }
    else {
        notes.push(`expected at least two tool calls (mutate + verify), got ${toolCalls.length}`);
    }
    if (content.length <= 420) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for mutate+verify flow (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    const mutatingNames = new Set([
        "apply_patch",
        "replace_in_files",
        "replace_string_in_file",
        "multi_replace_string_in_file",
        "edit_file",
        "create_file",
    ]);
    let useful = 0;
    const hasMutation = toolCalls.some((call) => mutatingNames.has(call.function.name));
    const hasVerification = toolCalls.some((call) => {
        if (call.function.name === "get_errors") {
            return true;
        }
        if (call.function.name !== "run_in_terminal") {
            return false;
        }
        const args = normalizeArgs(call.function.arguments);
        const command = String(args.command ?? "").toLowerCase();
        return /\b(test|lint|typecheck|types|build|compile|verify|tsc)\b/.test(command);
    });
    if (hasMutation) {
        useful += 0.55;
    }
    else {
        notes.push("did not perform any mutating action before concluding");
    }
    if (hasVerification) {
        useful += 0.45;
    }
    else {
        notes.push("did not run verification after mutation (expected get_errors or test/lint/build command)");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreRepoInstructionBootstrap(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one instruction bootstrap call, got ${toolCalls.length}`);
    }
    if (content.length <= 320) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for instruction bootstrap (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "create_file") {
        notes.push(`expected create_file, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const filePath = String(args.filePath ?? "").replace(/\\/g, "/");
    const fileContent = String(args.content ?? "").toLowerCase();
    if (filePath.endsWith(".github/copilot-instructions.md")) {
        useful += 0.4;
    }
    else {
        notes.push(`expected .github/copilot-instructions.md path, got '${filePath}'`);
    }
    if (fileContent.includes("build") && fileContent.includes("test")) {
        useful += 0.3;
    }
    else {
        notes.push("instructions missing concrete build/test guidance");
    }
    if (fileContent.includes("verify") ||
        fileContent.includes("get_errors") ||
        fileContent.includes("spec") ||
        fileContent.includes("acceptance criteria")) {
        useful += 0.3;
    }
    else {
        notes.push("instructions missing verification/spec-compliance standards");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreDebugFixVerifyWorkflow(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length >= 3) {
        format += 0.45;
    }
    else {
        notes.push(`expected at least three calls (diagnose → mutate → verify), got ${toolCalls.length}`);
    }
    if (content.length <= 520) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for debug-fix-verify workflow (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    const mutatingNames = new Set([
        "apply_patch",
        "replace_in_files",
        "replace_string_in_file",
        "multi_replace_string_in_file",
        "edit_file",
        "create_file",
    ]);
    const calls = toolCalls.map((call) => ({
        name: call.function.name,
        args: normalizeArgs(call.function.arguments),
    }));
    const firstDiagnosisIndex = calls.findIndex((call) => call.name === "get_errors" ||
        call.name === "grep_search" ||
        call.name === "read_file");
    const firstMutationIndex = calls.findIndex((call) => mutatingNames.has(call.name));
    const verifyAfterMutationIndex = calls.findIndex((call, index) => index > firstMutationIndex &&
        (call.name === "get_errors" ||
            (call.name === "run_in_terminal" &&
                /\b(test|lint|typecheck|types|build|compile|verify|tsc)\b/.test(String(call.args.command ?? "").toLowerCase()))));
    let useful = 0;
    if (firstDiagnosisIndex >= 0) {
        useful += 0.3;
    }
    else {
        notes.push("workflow missing explicit diagnosis step");
    }
    if (firstMutationIndex >= 0) {
        useful += 0.35;
    }
    else {
        notes.push("workflow missing a mutating fix step");
    }
    if (firstDiagnosisIndex >= 0 &&
        firstMutationIndex >= 0 &&
        firstDiagnosisIndex < firstMutationIndex) {
        useful += 0.15;
    }
    else {
        notes.push("diagnosis did not occur before mutation");
    }
    if (verifyAfterMutationIndex >= 0) {
        useful += 0.2;
    }
    else {
        notes.push("workflow missing post-mutation verification step");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreReadContextOneStep(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one read call, got ${toolCalls.length}`);
    }
    if (content.length <= 300) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for one-step read context (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "read_file") {
        notes.push(`expected read_file, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const filePath = String(args.filePath ?? "")
        .replace(/\\/g, "/")
        .toLowerCase();
    const startLine = Number(args.startLine ?? 0);
    const endLine = Number(args.endLine ?? 0);
    if (filePath.endsWith("readme.md") || filePath === "readme.md") {
        useful += 0.4;
    }
    else {
        notes.push(`expected README path, got '${filePath}'`);
    }
    if (Number.isFinite(startLine) &&
        Number.isFinite(endLine) &&
        startLine <= 5 &&
        endLine >= 100) {
        useful += 0.4;
    }
    else {
        notes.push(`expected broad requested line range (1-120 style), got ${startLine}-${endLine}`);
    }
    if (endLine > startLine) {
        useful += 0.2;
    }
    else {
        notes.push("endLine must be greater than startLine for meaningful context read");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scorePatchEditDiscipline(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one patch call, got ${toolCalls.length}`);
    }
    if (content.length <= 340) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for patch discipline case (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "apply_patch") {
        notes.push(`expected apply_patch, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const patchInput = String(args.input ?? "");
    if (patchInput.includes("*** Begin Patch") &&
        patchInput.includes("*** End Patch")) {
        useful += 0.35;
    }
    else {
        notes.push("apply_patch input missing canonical patch envelope");
    }
    if (/\*\*\* Update File: .*README\.md/i.test(patchInput)) {
        useful += 0.35;
    }
    else {
        notes.push("patch did not target README.md as requested");
    }
    if (!toolCalls.some((entry) => entry.function.name === "run_in_terminal")) {
        useful += 0.3;
    }
    else {
        notes.push("patch-discipline case should not use terminal for simple README edit");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreVscodeRepoResearch(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one repository lookup call, got ${toolCalls.length}`);
    }
    if (content.length <= 360) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for vscode repo lookup (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "github_repo") {
        notes.push(`expected github_repo, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const repo = String(args.repo ?? "").toLowerCase();
    const query = String(args.query ?? "").toLowerCase();
    if (repo === "microsoft/vscode") {
        useful += 0.4;
    }
    else {
        notes.push(`wrong repository for vscode standards lookup (${repo})`);
    }
    if (query.includes("prompt") ||
        query.includes("agent") ||
        query.includes("instructions")) {
        useful += 0.35;
    }
    else {
        notes.push("query missed prompt/agent/instructions behavior intent");
    }
    if (query.includes("test") ||
        query.includes("verify") ||
        query.includes("validation")) {
        useful += 0.25;
    }
    else {
        notes.push("query missed validation/testing intent");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreSafeGitProbe(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length === 1) {
        format += 0.45;
    }
    else {
        notes.push(`expected exactly one terminal call, got ${toolCalls.length}`);
    }
    if (content.length <= 260) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for git probe (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    let useful = 0;
    const call = toolCalls[0];
    if (!call || call.function.name !== "run_in_terminal") {
        notes.push(`expected run_in_terminal, got ${call?.function.name ?? "none"}`);
        return { format: clamp01(format), useful: 0, notes };
    }
    const args = normalizeArgs(call.function.arguments);
    const command = String(args.command ?? "")
        .trim()
        .toLowerCase();
    if (command === "git status --short" || command === "git status -sb") {
        useful += 0.6;
    }
    else {
        notes.push(`expected safe git status probe command, got '${command}'`);
    }
    if (!/&&|\|\||;|\n/.test(command)) {
        useful += 0.2;
    }
    else {
        notes.push("git probe command used command chaining");
    }
    if (!/rm\s+-rf|sudo\s+|curl\s+|wget\s+|chmod\s+|chown\s+/i.test(command)) {
        useful += 0.2;
    }
    else {
        notes.push("git probe command included destructive or unrelated operations");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
function scoreReadmeOnlyFixWorkflow(observation) {
    const notes = [];
    const content = observation.content.trim();
    const toolCalls = observation.toolCalls;
    let format = 0;
    if (toolCalls.length >= 2) {
        format += 0.45;
    }
    else {
        notes.push(`expected at least two calls (fix + verify), got ${toolCalls.length}`);
    }
    if (content.length <= 500) {
        format += 0.25;
    }
    else {
        notes.push(`response too verbose for README-only fix workflow (${content.length} chars)`);
    }
    if (!/<function\s*=|<local_qwen_tool_call>|Running\s+[a-z0-9_.-]+\./i.test(content)) {
        format += 0.3;
    }
    else {
        notes.push("response contained pseudo-tool formatting instead of native tool_calls");
    }
    const calls = toolCalls.map((call) => ({
        name: call.function.name,
        args: normalizeArgs(call.function.arguments),
    }));
    const patchCalls = calls.filter((call) => call.name === "apply_patch");
    const verifyCalls = calls.filter((call) => call.name === "get_errors" ||
        (call.name === "run_in_terminal" &&
            /\b(test|lint|typecheck|types|build|compile|verify|tsc)\b/.test(String(call.args.command ?? "").toLowerCase())));
    let useful = 0;
    if (patchCalls.length > 0) {
        useful += 0.35;
        const allReadmeOnly = patchCalls.every((call) => {
            const patchInput = String(call.args.input ?? "");
            return (/\*\*\* Update File: .*README\.md/i.test(patchInput) &&
                !/\*\*\* Update File: .*src\//i.test(patchInput));
        });
        if (allReadmeOnly) {
            useful += 0.35;
        }
        else {
            notes.push("patch scope drifted beyond README.md");
        }
    }
    else {
        notes.push("workflow missing apply_patch mutation");
    }
    if (verifyCalls.length > 0) {
        useful += 0.3;
    }
    else {
        notes.push("workflow missing post-fix verification step");
    }
    return { format: clamp01(format), useful: clamp01(useful), notes };
}
suite("E2E deep correctness (format + useful compliance, opt-in)", function () {
    this.timeout(300000);
    const runE2E = process.env.LOCAL_QWEN_E2E_DEEP === "1";
    const endpoint = process.env.LOCAL_QWEN_E2E_ENDPOINT ?? "http://localhost:11434";
    const model = process.env.LOCAL_QWEN_E2E_MODEL ?? "qwen3-coder:30b-256k";
    const flowMode = (String(process.env.LOCAL_QWEN_E2E_DEEP_FLOW ?? "provider").toLowerCase() ===
        "raw"
        ? "raw"
        : "provider");
    const minFormat = Math.min(1, Math.max(0, toNumber(process.env.LOCAL_QWEN_E2E_DEEP_MIN_FORMAT, 0.9)));
    const minUseful = Math.min(1, Math.max(0, toNumber(process.env.LOCAL_QWEN_E2E_DEEP_MIN_USEFUL, 0.9)));
    const minOverall = Math.min(1, Math.max(0, toNumber(process.env.LOCAL_QWEN_E2E_DEEP_MIN_OVERALL, 0.9)));
    const minCaseUseful = Math.min(1, Math.max(0, toNumber(process.env.LOCAL_QWEN_E2E_DEEP_MIN_CASE_USEFUL, 0.75)));
    const client = new ollamaClient_1.OllamaClient();
    const provider = new localLanguageModelProvider_1.LocalLanguageModelProvider({
        appendLine: () => { },
    });
    let blankWorkspace = "";
    const oneStepTools = [
        {
            type: "function",
            function: {
                name: "create_new_workspace",
                description: "Create a new full project workspace.",
                parameters: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "create_file",
                description: "Create a new file with content.",
                parameters: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        content: { type: "string" },
                    },
                    required: ["filePath", "content"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "mcp_pylance_mcp_s_pylanceRunCodeSnippet",
                description: "Execute a Python code snippet in workspace environment.",
                parameters: {
                    type: "object",
                    properties: {
                        workspaceRoot: { type: "string" },
                        codeSnippet: { type: "string" },
                        workingDirectory: { type: "string" },
                    },
                    required: ["workspaceRoot", "codeSnippet"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                },
            },
        },
    ];
    const intentTools = [
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
                name: "grep_search",
                description: "Search text in files.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        isRegexp: { type: "boolean" },
                    },
                    required: ["query", "isRegexp"],
                },
            },
        },
    ];
    const repoResearchTools = [
        {
            type: "function",
            function: {
                name: "github_repo",
                description: "Search a specific GitHub repository for relevant code snippets.",
                parameters: {
                    type: "object",
                    properties: {
                        repo: { type: "string" },
                        query: { type: "string" },
                    },
                    required: ["repo", "query"],
                },
            },
        },
    ];
    const safeTerminalTools = [
        {
            type: "function",
            function: {
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                },
            },
        },
    ];
    const mutationVerificationTools = [
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
        {
            type: "function",
            function: {
                name: "get_errors",
                description: "Get compile or lint errors in workspace.",
                parameters: {
                    type: "object",
                    properties: {
                        filePaths: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                },
            },
        },
        {
            type: "function",
            function: {
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                },
            },
        },
    ];
    const instructionBootstrapTools = [
        {
            type: "function",
            function: {
                name: "create_file",
                description: "Create a new file with content.",
                parameters: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        content: { type: "string" },
                    },
                    required: ["filePath", "content"],
                },
            },
        },
    ];
    const debugFixVerifyTools = [
        {
            type: "function",
            function: {
                name: "get_errors",
                description: "Get compile or lint errors in workspace.",
                parameters: {
                    type: "object",
                    properties: {
                        filePaths: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                },
            },
        },
        {
            type: "function",
            function: {
                name: "grep_search",
                description: "Search text in files.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        isRegexp: { type: "boolean" },
                    },
                    required: ["query", "isRegexp"],
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
                name: "apply_patch",
                description: "Apply a minimal patch to existing files.",
                parameters: {
                    type: "object",
                    properties: {
                        input: { type: "string" },
                        explanation: { type: "string" },
                    },
                    required: ["input", "explanation"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                },
            },
        },
    ];
    const readContextTools = [
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
    ];
    const patchDisciplineTools = [
        {
            type: "function",
            function: {
                name: "apply_patch",
                description: "Apply a minimal patch to existing files.",
                parameters: {
                    type: "object",
                    properties: {
                        input: { type: "string" },
                        explanation: { type: "string" },
                    },
                    required: ["input", "explanation"],
                },
            },
        },
    ];
    const vscodeRepoResearchTools = [
        {
            type: "function",
            function: {
                name: "github_repo",
                description: "Search a specific GitHub repository for relevant code snippets.",
                parameters: {
                    type: "object",
                    properties: {
                        repo: { type: "string" },
                        query: { type: "string" },
                    },
                    required: ["repo", "query"],
                },
            },
        },
    ];
    const safeGitProbeTools = [
        {
            type: "function",
            function: {
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                },
            },
        },
    ];
    const readmeOnlyFixTools = [
        {
            type: "function",
            function: {
                name: "apply_patch",
                description: "Apply a minimal patch to existing files.",
                parameters: {
                    type: "object",
                    properties: {
                        input: { type: "string" },
                        explanation: { type: "string" },
                    },
                    required: ["input", "explanation"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "get_errors",
                description: "Get compile or lint errors in workspace.",
                parameters: {
                    type: "object",
                    properties: {
                        filePaths: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                },
            },
        },
        {
            type: "function",
            function: {
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                },
            },
        },
    ];
    setup(async () => {
        blankWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-deep-correctness-"));
    });
    (runE2E ? test : test.skip)("format compliance and useful result compliance both satisfy strict thresholds", async () => {
        const cases = [];
        const scaffoldObservation = await singleTurn(client, provider, flowMode, endpoint, model, `In blank workspace '${blankWorkspace}', start a Vite project with exactly one tool call.`, oneStepTools);
        cases.push({
            name: "vite-scaffold",
            score: scoreViteScaffold(scaffoldObservation, blankWorkspace),
        });
        const marker = "<h1>Deep Correctness Marker</h1>";
        const createHtmlObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            `In blank workspace '${blankWorkspace}', create index.html with exact marker ${marker}.`,
            "Use exactly one tool call only.",
        ].join(" "), oneStepTools);
        cases.push({
            name: "create-index-html",
            score: scoreCreateHtml(createHtmlObservation, blankWorkspace, marker),
        });
        const pythonObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            `In blank workspace '${blankWorkspace}', run this python snippet: print(2 + 2).`,
            "Use exactly one tool call only and do not use terminal commands.",
        ].join(" "), oneStepTools);
        cases.push({
            name: "python-snippet",
            score: scorePythonSnippet(pythonObservation, blankWorkspace),
        });
        const intentObservation = await streamTurn(client, provider, flowMode, endpoint, model, [
            {
                role: "system",
                content: "You are a coding agent. Keep the original replacement mapping stable through noise and corrections. Never invert from/to.",
            },
            {
                role: "user",
                content: "Instead of /assets/level1.json, use /level1.json everywhere in the project.",
            },
            {
                role: "assistant",
                content: "Running read_file. Running grep_search. I found unrelated files and will keep exploring.",
            },
            {
                role: "user",
                content: "Noise: output chunks from unrelated files. Do not drift from the original mapping.",
            },
            {
                role: "user",
                content: "Continue the same replacement intent and finish efficiently with minimal repetition.",
            },
        ], intentTools);
        cases.push({
            name: "intent-persistence",
            score: scoreIntentPersistence(intentObservation),
        });
        const repoResearchObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Using exactly one tool call, search github/awesome-copilot for guidance on agent safety and verification.",
            "Use github_repo with repo set exactly to github/awesome-copilot.",
        ].join(" "), repoResearchTools);
        cases.push({
            name: "repo-research-spec-compliance",
            score: scoreRepositoryResearch(repoResearchObservation),
        });
        const safeTerminalObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Run exactly one non-destructive command to print the Node.js version.",
            "Use run_in_terminal and avoid command chaining or any other operation.",
        ].join(" "), safeTerminalTools);
        cases.push({
            name: "safe-terminal-focus",
            score: scoreSafeTerminalProbe(safeTerminalObservation),
        });
        const mutationVerificationObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Replace 'teh' with 'the' everywhere in the workspace, then verify for workspace errors.",
            "Do not stop after editing; include verification in the same turn with minimal tool calls.",
        ].join(" "), mutationVerificationTools);
        cases.push({
            name: "mutation-then-verification",
            score: scoreMutationWithVerification(mutationVerificationObservation),
        });
        const instructionBootstrapObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Create .github/copilot-instructions.md in this repository with practical standards used by active Copilot teams.",
            "Include concise rules for build/test commands, spec compliance, and verify-after-change behavior.",
            "Use exactly one tool call.",
        ].join(" "), instructionBootstrapTools);
        cases.push({
            name: "repo-instruction-bootstrap",
            score: scoreRepoInstructionBootstrap(instructionBootstrapObservation),
        });
        const debugFixVerifyObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Perform a realistic coding-agent fix workflow: diagnose current errors, apply a minimal root-cause fix, then verify again.",
            "Use tools in this order: diagnose -> mutate -> verify. Keep the sequence concise and focused.",
        ].join(" "), debugFixVerifyTools);
        cases.push({
            name: "debug-fix-verify-workflow",
            score: scoreDebugFixVerifyWorkflow(debugFixVerifyObservation),
        });
        const readContextObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Read README.md lines 1-120 and return a brief summary.",
            "Use exactly one read_file tool call.",
        ].join(" "), readContextTools);
        cases.push({
            name: "read-context-one-step",
            score: scoreReadContextOneStep(readContextObservation),
        });
        const patchDisciplineObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Edit existing README.md by changing 'Quality thresholds only' to 'Quality standards only'.",
            "Use exactly one apply_patch call and no terminal command.",
        ].join(" "), patchDisciplineTools);
        cases.push({
            name: "patch-edit-discipline",
            score: scorePatchEditDiscipline(patchDisciplineObservation),
        });
        const vscodeRepoObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Using exactly one tool call, search microsoft/vscode for prompt + agent instruction validation behavior.",
            "Use github_repo with repo set exactly to microsoft/vscode.",
        ].join(" "), vscodeRepoResearchTools);
        cases.push({
            name: "vscode-repo-research-spec-compliance",
            score: scoreVscodeRepoResearch(vscodeRepoObservation),
        });
        const safeGitProbeObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Run exactly one safe command to inspect repository status.",
            "Use run_in_terminal with git status only, no command chaining.",
        ].join(" "), safeGitProbeTools);
        cases.push({
            name: "safe-git-probe",
            score: scoreSafeGitProbe(safeGitProbeObservation),
        });
        const readmeOnlyFixObservation = await singleTurn(client, provider, flowMode, endpoint, model, [
            "Fix a README.md typo with apply_patch, keep scope strictly README.md, then verify after the change.",
            "Do not modify src files. Include a verification step before concluding.",
        ].join(" "), readmeOnlyFixTools);
        cases.push({
            name: "readme-only-fix-workflow",
            score: scoreReadmeOnlyFixWorkflow(readmeOnlyFixObservation),
        });
        const formatAverage = cases.reduce((sum, entry) => sum + entry.score.format, 0) /
            cases.length;
        const usefulAverage = cases.reduce((sum, entry) => sum + entry.score.useful, 0) /
            cases.length;
        const overallAverage = (formatAverage + usefulAverage) / 2;
        const failingCases = cases
            .filter((entry) => entry.score.format < minFormat ||
            entry.score.useful < minUseful ||
            entry.score.useful < minCaseUseful)
            .map((entry) => `${entry.name}: format=${entry.score.format.toFixed(2)} useful=${entry.score.useful.toFixed(2)} notes=${entry.score.notes.join(" | ")}`);
        const summary = [
            `flowMode=${flowMode}`,
            `formatAverage=${formatAverage.toFixed(3)} (min=${minFormat.toFixed(3)})`,
            `usefulAverage=${usefulAverage.toFixed(3)} (min=${minUseful.toFixed(3)})`,
            `minCaseUseful=${minCaseUseful.toFixed(3)}`,
            `overallAverage=${overallAverage.toFixed(3)} (min=${minOverall.toFixed(3)})`,
            ...failingCases,
        ].join("\n");
        strict_1.default.ok(formatAverage >= minFormat &&
            usefulAverage >= minUseful &&
            overallAverage >= minOverall &&
            failingCases.length === 0, `deep correctness gate failed\n${summary}`);
    });
});
//# sourceMappingURL=e2eDeepCorrectness.test.js.map