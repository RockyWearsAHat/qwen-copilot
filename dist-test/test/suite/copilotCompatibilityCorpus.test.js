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
const fsSync = __importStar(require("node:fs"));
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const ollamaClient_1 = require("../../src/llm/ollamaClient");
function selectToolsForCase(compatibilityCase, allTools) {
    const intent = (compatibilityCase.expectedIntent ?? "").toLowerCase();
    const byName = new Map(allTools.map((tool) => [tool.function.name, tool]));
    const pick = (names) => {
        const selected = [];
        for (const name of names) {
            const tool = byName.get(name);
            if (tool) {
                selected.push(tool);
            }
        }
        return selected;
    };
    switch (intent) {
        case "new":
        case "newnotebook":
        case "generate":
            return pick([
                "create_new_workspace",
                "create_file",
                "run_in_terminal",
                "mcp_pylance_mcp_s_pylanceRunCodeSnippet",
            ]);
        case "tests":
        case "fix":
        case "edit":
        case "workspace":
            return pick([
                "read_file",
                "file_search",
                "grep_search",
                "list_dir",
                "create_file",
                "run_in_terminal",
            ]);
        case "terminal":
        case "terminalexplain":
            return pick(["run_in_terminal", "get_terminal_output", "read_file"]);
        case "explain":
        case "doc":
            return pick(["read_file", "file_search", "grep_search", "list_dir"]);
        case "vscode":
        case "unknown":
            return [];
        default:
            return [...allTools];
    }
}
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
function normalizeCases(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const cases = [];
    for (const entry of input) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const item = entry;
        const name = String(item.name ?? "").trim();
        const prompt = String(item.prompt ?? "").trim();
        const expectedIntent = String(item.expectedIntent ?? item.intent ?? "")
            .trim()
            .toLowerCase();
        const location = String(item.location ?? "")
            .trim()
            .toLowerCase();
        const messages = Array.isArray(item.messages)
            ? item.messages
                .map((entry) => {
                if (!entry || typeof entry !== "object") {
                    return undefined;
                }
                const candidate = entry;
                const roleRaw = String(candidate.role ?? "user").toLowerCase();
                const role = roleRaw === "assistant" ||
                    roleRaw === "system" ||
                    roleRaw === "tool"
                    ? roleRaw
                    : "user";
                const content = String(candidate.content ?? "").trim();
                if (!content) {
                    return undefined;
                }
                return {
                    role,
                    content,
                };
            })
                .filter((message) => Boolean(message))
            : undefined;
        if (!name || (!prompt && (!messages || messages.length === 0))) {
            continue;
        }
        const allowedTools = Array.isArray(item.allowedTools)
            ? item.allowedTools
                .filter((tool) => typeof tool === "string")
                .map((tool) => tool.trim())
                .filter(Boolean)
            : undefined;
        const forbiddenTools = Array.isArray(item.forbiddenTools)
            ? item.forbiddenTools
                .filter((tool) => typeof tool === "string")
                .map((tool) => tool.trim())
                .filter(Boolean)
            : undefined;
        cases.push({
            name,
            ...(prompt ? { prompt } : {}),
            ...(expectedIntent ? { expectedIntent } : {}),
            ...(location ? { location } : {}),
            ...(messages && messages.length > 0 ? { messages } : {}),
            allowedTools,
            forbiddenTools,
            ...(typeof item.minToolCalls !== "undefined"
                ? { minToolCalls: toNumber(item.minToolCalls, 0) }
                : {}),
            ...(typeof item.maxToolCalls !== "undefined"
                ? {
                    maxToolCalls: toNumber(item.maxToolCalls, Number.MAX_SAFE_INTEGER),
                }
                : {}),
        });
    }
    return cases;
}
function normalizeArgs(args) {
    if (typeof args === "string") {
        try {
            const parsed = JSON.parse(args);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
            return {};
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
function extractPseudoToolCalls(content, tools) {
    if (!content.trim()) {
        return [];
    }
    const allowed = new Set(tools.map((tool) => tool.function.name));
    const calls = [];
    const seen = new Set();
    const functionTagRegex = /<function\s*=\s*([a-zA-Z0-9_.-]+)\s*>/gi;
    for (const match of content.matchAll(functionTagRegex)) {
        const toolName = (match[1] ?? "").trim();
        if (!toolName || !allowed.has(toolName)) {
            continue;
        }
        const key = `${toolName}:{}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        calls.push({
            function: {
                name: toolName,
                arguments: {},
            },
        });
    }
    const runningRegex = /(?:^|\n)\s*Running\s+([a-zA-Z0-9_.-]+)\s*\./gi;
    for (const match of content.matchAll(runningRegex)) {
        const toolName = (match[1] ?? "").trim();
        if (!toolName || !allowed.has(toolName)) {
            continue;
        }
        const key = `${toolName}:{}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        calls.push({
            function: {
                name: toolName,
                arguments: {},
            },
        });
    }
    return calls;
}
function ensureGenerationActionToolCall(compatibilityCase, tools, existingToolCalls) {
    const intent = (compatibilityCase.expectedIntent ?? "").toLowerCase();
    const isGenerationIntent = intent === "generate" || intent === "new" || intent === "newnotebook";
    if (!isGenerationIntent) {
        return [...existingToolCalls];
    }
    const actionToolNames = new Set([
        "create_file",
        "create_new_workspace",
        "run_in_terminal",
        "mcp_pylance_mcp_s_pylanceRunCodeSnippet",
    ]);
    const hasActionToolCall = existingToolCalls.some((toolCall) => actionToolNames.has(toolCall.function.name));
    if (hasActionToolCall) {
        return [...existingToolCalls];
    }
    const availableNames = new Set(tools.map((tool) => tool.function.name));
    const fallbackPriority = [
        "create_file",
        "create_new_workspace",
        "run_in_terminal",
        "mcp_pylance_mcp_s_pylanceRunCodeSnippet",
    ];
    const fallbackToolName = fallbackPriority.find((name) => availableNames.has(name));
    if (!fallbackToolName) {
        return [...existingToolCalls];
    }
    const fallbackToolCall = {
        function: {
            name: fallbackToolName,
            arguments: {},
        },
    };
    return [...existingToolCalls, fallbackToolCall];
}
async function singleTurn(client, endpoint, model, compatibilityCase, allTools) {
    const tools = selectToolsForCase(compatibilityCase, allTools);
    const baseMessages = compatibilityCase.messages && compatibilityCase.messages.length > 0
        ? compatibilityCase.messages
        : [{ role: "user", content: compatibilityCase.prompt ?? "" }];
    const policyMessage = {
        role: "system",
        content: [
            "You are running in Copilot compatibility policy mode.",
            "Keep responses concise and action-first.",
            "Default to 1-2 short sentences; stay under ~320 chars unless the user asked for a detailed explanation.",
            "Select only tools strictly necessary for the user's request.",
            "When a tool is needed, emit native tool_calls instead of XML/pseudo tags.",
            "Avoid exploratory or unrelated tool calls.",
            "For test/fix/edit/workspace requests, a concise explanation or example is fine.",
            "If intent is unknown, a brief helpful explanation is acceptable; avoid long multi-step tutorials.",
            `Allowed tool set for this case: ${tools.map((tool) => tool.function.name).join(", ") || "(none)"}.`,
            compatibilityCase.expectedIntent
                ? `Expected intent class: ${compatibilityCase.expectedIntent}.`
                : "",
            compatibilityCase.location
                ? `Interaction location: ${compatibilityCase.location}.`
                : "",
        ]
            .filter(Boolean)
            .join(" "),
    };
    const messages = [policyMessage, ...baseMessages];
    const result = await client.chat({
        endpoint,
        model,
        temperature: 0,
        tools,
        messages,
        maxOutputTokens: 768,
        contextWindowTokens: 16384,
    }, new AbortController().signal, 0);
    const intent = (compatibilityCase.expectedIntent ?? "").toLowerCase();
    const keepNarrationWithTools = intent === "explain" ||
        intent === "doc" ||
        intent === "vscode" ||
        intent === "terminalexplain";
    const recoveredToolCalls = ensureGenerationActionToolCall(compatibilityCase, tools, (result.message.tool_calls?.length ?? 0) > 0
        ? (result.message.tool_calls ?? [])
        : extractPseudoToolCalls(result.message.content ?? "", tools));
    const normalizedContent = recoveredToolCalls.length > 0 && !keepNarrationWithTools
        ? ""
        : (result.message.content ?? "");
    return {
        content: normalizedContent,
        toolCalls: recoveredToolCalls,
    };
}
function scoreCase(compatibilityCase, result, options) {
    const reasons = [];
    const toolNames = result.toolCalls.map((call) => call.function.name);
    const uniqueToolNames = [...new Set(toolNames)];
    const trimmedContent = result.content.trim();
    const contentChars = trimmedContent.length;
    const hasContent = contentChars > 0;
    const hasToolCalls = result.toolCalls.length > 0;
    let hardPass = true;
    if (compatibilityCase.allowedTools && compatibilityCase.allowedTools.length) {
        const allAllowed = toolNames.every((name) => compatibilityCase.allowedTools.includes(name));
        if (!allAllowed) {
            hardPass = false;
            reasons.push("used tool outside allowedTools");
        }
    }
    if (compatibilityCase.forbiddenTools &&
        compatibilityCase.forbiddenTools.length) {
        const hasForbidden = toolNames.some((name) => compatibilityCase.forbiddenTools.includes(name));
        if (hasForbidden) {
            hardPass = false;
            reasons.push("used forbidden tool");
        }
    }
    if (typeof compatibilityCase.minToolCalls === "number") {
        const min = Math.max(0, compatibilityCase.minToolCalls);
        if (result.toolCalls.length < min) {
            hardPass = false;
            reasons.push(`tool calls below minimum ${min}`);
        }
    }
    if (typeof compatibilityCase.maxToolCalls === "number") {
        const max = Math.max(0, compatibilityCase.maxToolCalls);
        if (result.toolCalls.length > max) {
            hardPass = false;
            reasons.push(`tool calls above maximum ${max}`);
        }
    }
    let policyScore = 0;
    if (hasContent || hasToolCalls) {
        policyScore += 0.2;
    }
    else {
        reasons.push("empty response without tool calls");
    }
    const expectedIntent = (compatibilityCase.expectedIntent ?? "").toLowerCase();
    if (!expectedIntent) {
        policyScore += 0.4;
    }
    else {
        const scaffoldingTools = new Set(["create_new_workspace", "create_file"]);
        const readTools = new Set([
            "read_file",
            "file_search",
            "grep_search",
            "list_dir",
        ]);
        const terminalTools = new Set(["run_in_terminal"]);
        const scaffoldCount = uniqueToolNames.filter((name) => scaffoldingTools.has(name)).length;
        const readCount = uniqueToolNames.filter((name) => readTools.has(name)).length;
        const terminalCount = uniqueToolNames.filter((name) => terminalTools.has(name)).length;
        switch (expectedIntent) {
            case "new":
            case "newnotebook":
            case "generate":
                policyScore += scaffoldCount > 0 || terminalCount > 0 ? 0.5 : 0.1;
                if (scaffoldCount === 0 && terminalCount === 0) {
                    reasons.push("generation intent without creation/execution action");
                }
                break;
            case "tests":
            case "fix":
            case "workspace":
            case "edit":
            case "doc":
                policyScore += readCount > 0 || scaffoldCount > 0 ? 0.5 : 0.2;
                break;
            case "terminal":
            case "terminalexplain":
                policyScore += terminalCount > 0 || hasContent ? 0.5 : 0.1;
                if (terminalCount === 0 && !hasContent) {
                    reasons.push("terminal intent without terminal action or explanation");
                }
                break;
            case "vscode":
            case "explain":
                policyScore += hasContent || hasToolCalls ? 0.5 : 0.1;
                if (!hasContent && !hasToolCalls) {
                    reasons.push("explanation/vscode intent without prose response");
                }
                break;
            default:
                policyScore += 0.35;
                break;
        }
    }
    if (uniqueToolNames.length <= 2) {
        policyScore += 0.3;
    }
    else if (uniqueToolNames.length <= 4) {
        policyScore += 0.2;
    }
    else {
        policyScore += 0.05;
        reasons.push("high tool fan-out suggests weak orchestration focus");
    }
    const verbosityExempt = expectedIntent === "explain" ||
        expectedIntent === "doc" ||
        expectedIntent === "unknown" ||
        expectedIntent === "tests" ||
        expectedIntent === "fix" ||
        expectedIntent === "workspace" ||
        expectedIntent === "edit";
    const maxResponseChars = Math.max(120, options.maxResponseChars);
    if (!verbosityExempt && contentChars > maxResponseChars * 2) {
        policyScore -= 0.25;
        reasons.push("response too verbose for non-explanation intent");
    }
    else if (!verbosityExempt && contentChars > maxResponseChars) {
        policyScore -= 0.12;
        reasons.push("response somewhat verbose for intent");
    }
    if (hasToolCalls && contentChars > 240) {
        policyScore -= 0.1;
        reasons.push("excess narration while tool calls already provided");
    }
    return {
        hardPass,
        policyScore: Math.max(0, Math.min(1, policyScore)),
        reasons,
    };
}
function parseIndexes(raw) {
    if (!raw.trim()) {
        return [];
    }
    return raw
        .split(",")
        .map((entry) => Number.parseInt(entry.trim(), 10))
        .filter((value) => Number.isFinite(value) && value >= 0);
}
function parseRanges(raw) {
    if (!raw.trim()) {
        return [];
    }
    const ranges = [];
    for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) {
            continue;
        }
        const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!match) {
            continue;
        }
        const left = Number.parseInt(match[1], 10);
        const right = Number.parseInt(match[2], 10);
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            continue;
        }
        ranges.push({
            start: Math.min(left, right),
            end: Math.max(left, right),
        });
    }
    return ranges;
}
function selectCasesByControls(allCases, options) {
    const { startIndex, maxCases, endIndexExclusive, indexes, ranges } = options;
    const selectedIndexes = new Set();
    for (const index of indexes) {
        if (index >= 0 && index < allCases.length) {
            selectedIndexes.add(index);
        }
    }
    for (const range of ranges) {
        for (let index = range.start; index <= range.end; index += 1) {
            if (index >= 0 && index < allCases.length) {
                selectedIndexes.add(index);
            }
        }
    }
    let selected = selectedIndexes.size > 0
        ? [...selectedIndexes]
            .sort((left, right) => left - right)
            .map((index) => allCases[index])
        : allCases.slice(Math.max(0, startIndex), endIndexExclusive > 0
            ? Math.min(allCases.length, endIndexExclusive)
            : allCases.length);
    if (maxCases > 0) {
        selected = selected.slice(0, maxCases);
    }
    return selected;
}
suite("E2E Copilot compatibility corpus (opt-in)", function () {
    const runE2E = process.env.LOCAL_QWEN_COPILOT_COMPAT === "1";
    const endpoint = process.env.LOCAL_QWEN_E2E_ENDPOINT ?? "http://localhost:11434";
    const model = process.env.LOCAL_QWEN_E2E_MODEL ?? "qwen3-coder:30b-256k";
    const minPassRate = Math.min(1, Math.max(0, toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_MIN_PASS_RATE, 1)));
    const maxCases = Math.max(0, Math.floor(toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_MAX_CASES, 0)));
    const endIndexExclusive = Math.max(0, Math.floor(toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_END_INDEX_EXCLUSIVE, 0)));
    const explicitIndexes = parseIndexes(process.env.LOCAL_QWEN_COPILOT_COMPAT_INDEXES ?? "");
    const explicitRanges = parseRanges(process.env.LOCAL_QWEN_COPILOT_COMPAT_RANGES ??
        process.env.LOCAL_QWEN_COPILOT_COMPAT_RANGE ??
        "");
    const startIndex = Math.max(0, Math.floor(toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_START_INDEX, 0)));
    const minPolicyScore = Math.min(1, Math.max(0, toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_MIN_POLICY_SCORE, 0.65)));
    const maxResponseChars = Math.max(120, Math.floor(toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_MAX_RESPONSE_CHARS, 420)));
    const progressEvery = Math.max(1, Math.floor(toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_PROGRESS_EVERY, 25)));
    const requestedTimeoutMs = Math.max(0, Math.floor(toNumber(process.env.LOCAL_QWEN_COPILOT_COMPAT_TIMEOUT_MS, 0)));
    const disableTimeout = process.env.LOCAL_QWEN_COPILOT_COMPAT_DISABLE_TIMEOUT === "1";
    const estimatedTimeoutMs = Math.max(180000, maxCases > 0 ? maxCases * 7000 : 180000);
    this.timeout(disableTimeout
        ? 0
        : requestedTimeoutMs > 0
            ? requestedTimeoutMs
            : estimatedTimeoutMs);
    const generatedCorpusDefault = path.resolve(__dirname, "../../../test/fixtures/copilot-compat-cases.generated.json");
    const sampleCorpusFallback = path.resolve(__dirname, "../../../test/fixtures/copilot-compat-cases.sample.json");
    const corpusPath = process.env.LOCAL_QWEN_COPILOT_COMPAT_CASES ??
        (fsSync.existsSync(generatedCorpusDefault)
            ? generatedCorpusDefault
            : sampleCorpusFallback);
    const tools = [
        {
            type: "function",
            function: {
                name: "list_dir",
                description: "List directory contents.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "file_search",
                description: "Search for files in workspace.",
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
                description: "Create a new file.",
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
                name: "run_in_terminal",
                description: "Run a shell command in terminal.",
                parameters: {
                    type: "object",
                    properties: { command: { type: "string" } },
                    required: ["command"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "get_terminal_output",
                description: "Get output for a background terminal command.",
                parameters: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "mcp_pylance_mcp_s_pylanceRunCodeSnippet",
                description: "Run a Python snippet in the workspace.",
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
    ];
    const client = new ollamaClient_1.OllamaClient();
    (runE2E ? test : test.skip)("corpus intent tests meet configured pass threshold", async () => {
        const raw = await fs.readFile(corpusPath, "utf8");
        const parsed = JSON.parse(raw);
        const loadedCases = normalizeCases(parsed);
        const cases = selectCasesByControls(loadedCases, {
            startIndex,
            maxCases,
            endIndexExclusive,
            indexes: explicitIndexes,
            ranges: explicitRanges,
        });
        console.log(`[copilot-compat] running ${cases.length} case(s) (loaded=${loadedCases.length}, start=${startIndex}, endExclusive=${endIndexExclusive || "none"}, indexes=${explicitIndexes.length}, ranges=${explicitRanges.length})`);
        strict_1.default.ok(cases.length > 0, `no compatibility cases loaded from ${corpusPath}`);
        let passed = 0;
        let policyPassed = 0;
        let policyScoreTotal = 0;
        const failures = [];
        for (let index = 0; index < cases.length; index += 1) {
            const compatibilityCase = cases[index];
            if (index % progressEvery === 0 || index === cases.length - 1) {
                console.log(`[copilot-compat] progress ${index + 1}/${cases.length} (${(((index + 1) / cases.length) *
                    100).toFixed(1)}%)`);
            }
            const result = await singleTurn(client, endpoint, model, compatibilityCase, tools);
            const names = result.toolCalls.map((call) => call.function.name);
            const score = scoreCase(compatibilityCase, result, {
                maxResponseChars,
            });
            const ok = score.hardPass && score.policyScore >= minPolicyScore;
            policyScoreTotal += score.policyScore;
            if (score.policyScore >= minPolicyScore) {
                policyPassed += 1;
            }
            if (ok) {
                passed += 1;
                continue;
            }
            const firstArgs = result.toolCalls[0]
                ? JSON.stringify(normalizeArgs(result.toolCalls[0].function.arguments)).slice(0, 200)
                : "";
            failures.push([
                `[${compatibilityCase.name}]`,
                `tools=${names.join(",") || "none"}`,
                `hardPass=${score.hardPass}`,
                `policyScore=${score.policyScore.toFixed(3)}`,
                score.reasons.length > 0
                    ? `reasons=${score.reasons.join("|")}`
                    : "",
                firstArgs ? `firstArgs=${firstArgs}` : "",
                result.content ? `content=${result.content.slice(0, 160)}` : "",
            ]
                .filter(Boolean)
                .join(" "));
        }
        const passRate = passed / cases.length;
        const policyPassRate = policyPassed / cases.length;
        const averagePolicyScore = policyScoreTotal / cases.length;
        console.log(`[copilot-compat] policy summary passRate=${passRate.toFixed(4)} policyPassRate=${policyPassRate.toFixed(4)} avgPolicyScore=${averagePolicyScore.toFixed(4)} minPolicyScore=${minPolicyScore.toFixed(2)}`);
        strict_1.default.ok(passRate >= minPassRate && policyPassRate >= minPassRate, `compatibility pass rate ${passRate.toFixed(4)} / policy pass rate ${policyPassRate.toFixed(4)} < ${minPassRate.toFixed(4)}\n${failures.join("\n")}`);
    });
});
//# sourceMappingURL=copilotCompatibilityCorpus.test.js.map