"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const localLanguageModelProvider_1 = require("../../src/llm/localLanguageModelProvider");
suite("LocalLanguageModelProvider", () => {
    const HUMAN_BUILD_FIX_REQUEST = "npm run build is failing with TypeScript errors. Please run npm run build and fix the errors.";
    function createProvider() {
        return new localLanguageModelProvider_1.LocalLanguageModelProvider({
            appendLine: () => { },
        });
    }
    test("shouldCompactContinuationMessages stays off for low token pressure", () => {
        const provider = createProvider();
        const messages = Array.from({ length: 30 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `msg-${index}`,
        }));
        const shouldCompact = provider.shouldCompactContinuationMessages(messages, 32768);
        strict_1.default.equal(shouldCompact, false);
    });
    test("shouldCompactContinuationMessages turns on under high token pressure", () => {
        const provider = createProvider();
        const largePayload = "x".repeat(6000);
        const messages = Array.from({ length: 30 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `${largePayload}-${index}`,
        }));
        const shouldCompact = provider.shouldCompactContinuationMessages(messages, 32768);
        strict_1.default.equal(shouldCompact, true);
    });
    test("compactEnvelopeUserMessage preserves user request and key constraints", () => {
        const provider = createProvider();
        const content = [
            "<context>The current date is February 22, 2026.</context>",
            "<reminderInstructions>Use tools and continue until fully resolved.</reminderInstructions>",
            "<userRequest>Start implementation</userRequest>",
        ].join("\n");
        const compacted = provider.compactEnvelopeUserMessage(content);
        strict_1.default.match(compacted, /Start implementation/);
        strict_1.default.match(compacted, /Current context:/);
        strict_1.default.match(compacted, /Execution constraints:/);
        strict_1.default.match(compacted, /fully resolved/);
    });
    test("withExecutionContextAnchor prepends objective anchor message", () => {
        const provider = createProvider();
        provider.persistedUserGoalForRequest = HUMAN_BUILD_FIX_REQUEST;
        const anchored = provider.withExecutionContextAnchor([
            {
                role: "user",
                content: "After running npm run build, VS Code reports 13 TS errors in src/platformerGame.ts",
            },
        ], HUMAN_BUILD_FIX_REQUEST);
        strict_1.default.equal(anchored.length, 2);
        strict_1.default.equal(anchored[0].role, "system");
        strict_1.default.match(anchored[0].content, /CONTEXT ANCHOR/i);
        strict_1.default.match(anchored[0].content, /Task:/);
        strict_1.default.match(anchored[0].content, /Current focus:/);
        strict_1.default.match(anchored[0].content, /Last result:/);
    });
    test("selectModelLookupBypassTools returns a local high-confidence selection", () => {
        const provider = createProvider();
        const tools = [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file contents with a line range.",
                    parameters: {
                        type: "object",
                        properties: { filePath: { type: "string" } },
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
                    },
                },
            },
        ];
        const selected = provider.selectModelLookupBypassTools("read file src/llm/localLanguageModelProvider.ts", tools, 8);
        strict_1.default.ok(selected.length >= 1);
        strict_1.default.equal(selected[0].function.name, "read_file");
    });
    test("toOllamaToolSpecs reuses cached conversion for identical tool set", () => {
        const provider = createProvider();
        const profile = localLanguageModelProvider_1.LocalLanguageModelProvider.performanceProfiles.fast;
        const tools = [
            {
                name: "read_file",
                description: "Read file with line range",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        startLine: { type: "number" },
                        endLine: { type: "number" },
                    },
                },
            },
        ];
        const first = provider.toOllamaToolSpecs(tools, profile, true, false);
        const second = provider.toOllamaToolSpecs(tools, profile, true, false);
        strict_1.default.equal(first, second);
        strict_1.default.equal(first.length, 1);
        strict_1.default.equal(first[0].function.name, "read_file");
    });
    test("compactToolCallBatch merges duplicate searches and overlapping file reads", () => {
        const provider = createProvider();
        const compacted = provider.compactToolCallBatch([
            {
                id: "a",
                function: {
                    name: "grep_search",
                    arguments: {
                        query: "localQwen",
                        isRegexp: false,
                        includePattern: "src/**",
                        maxResults: 20,
                    },
                },
            },
            {
                id: "b",
                function: {
                    name: "grep_search",
                    arguments: {
                        query: "localQwen",
                        isRegexp: false,
                        includePattern: "src/**",
                        maxResults: 200,
                    },
                },
            },
            {
                id: "c",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "src/llm/localLanguageModelProvider.ts",
                        startLine: 10,
                        endLine: 40,
                    },
                },
            },
            {
                id: "d",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "src/llm/localLanguageModelProvider.ts",
                        startLine: 35,
                        endLine: 60,
                    },
                },
            },
        ]);
        const grepCalls = compacted.filter((toolCall) => toolCall.function.name === "grep_search");
        const readCalls = compacted.filter((toolCall) => toolCall.function.name === "read_file");
        strict_1.default.equal(grepCalls.length, 1);
        strict_1.default.equal(grepCalls[0].function.arguments.maxResults, 200);
        strict_1.default.equal(readCalls.length, 1);
        strict_1.default.equal(readCalls[0].function.arguments.startLine, 10);
        strict_1.default.equal(readCalls[0].function.arguments.endLine, 60);
    });
    test("redirects piecemeal replacement edits to replace_in_files", () => {
        const outputLines = [];
        const provider = new localLanguageModelProvider_1.LocalLanguageModelProvider({
            appendLine: (line) => outputLines.push(line),
        });
        provider.currentLockedIntentForTurn =
            "Please replace '/old/path' with '/new/path' everywhere in the workspace.";
        const compacted = provider.compactToolCallBatch([
            {
                id: "1",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "src/a.ts",
                        oldString: "import '/old/path/file'",
                        newString: "import '/new/path/file'",
                    },
                },
            },
            {
                id: "2",
                function: {
                    name: "list_dir",
                    arguments: {
                        path: "src",
                    },
                },
            },
        ]);
        strict_1.default.equal(compacted.length, 1);
        strict_1.default.equal(compacted[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(compacted[0].function.arguments, {
            from: "old/path",
            to: "new/path",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
        strict_1.default.ok(outputLines.some((line) => line.includes("redirected 1 piecemeal edit(s)")));
    });
    test("replay transcript sequence redirects repeated piecemeal edits into one workspace replacement", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "Instead of /assets/level1.json, use /level1.json";
        const compacted = provider.compactToolCallBatch([
            {
                id: "1",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/platformerGame.ts",
                        oldString: "/assets/level1.json",
                        newString: "/level1.json",
                    },
                },
            },
            {
                id: "2",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/platformerGame.ts",
                        startLine: 20,
                        endLine: 30,
                    },
                },
            },
            {
                id: "3",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/platformerGame.ts",
                        oldString: "/assets/level1.json",
                        newString: "/level1.json",
                    },
                },
            },
        ]);
        strict_1.default.equal(compacted.length, 1);
        strict_1.default.equal(compacted[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(compacted[0].function.arguments, {
            from: "assets/level1.json",
            to: "level1.json",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
    });
    test("buildGuardrailFallbackToolCalls emits one-time replace_in_files recovery call", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn =
            "replace '/assets/old.png' with '/assets/new.png' everywhere";
        const specs = [
            {
                type: "function",
                function: {
                    name: "replace_in_files",
                    description: "Replace across files",
                    parameters: {},
                },
            },
        ];
        const first = provider.buildGuardrailFallbackToolCalls("I have fixed everything already. No further action needed.", specs);
        const second = provider.buildGuardrailFallbackToolCalls("I have fixed everything already. No further action needed.", specs);
        strict_1.default.equal(first.length, 1);
        strict_1.default.equal(first[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(first[0].function.arguments, {
            from: "assets/old.png",
            to: "assets/new.png",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
        strict_1.default.deepEqual(second, []);
    });
    test("guardrail fallback triggers on replay-style premature completion language", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "replace '/assets/ui.png' with '/ui.png' everywhere";
        const specs = [
            {
                type: "function",
                function: {
                    name: "replace_in_files",
                    description: "Replace across files",
                    parameters: {},
                },
            },
        ];
        const fallback = provider.buildGuardrailFallbackToolCalls("I've already fixed this. Let me know if you'd like anything else.", specs);
        strict_1.default.equal(fallback.length, 1);
        strict_1.default.equal(fallback[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(fallback[0].function.arguments, {
            from: "assets/ui.png",
            to: "ui.png",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
    });
    test("persists replacement intent across later noisy turns when current intent is missing", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "";
        provider.persistedReplacementIntent = {
            from: "assets/level1.json",
            to: "level1.json",
        };
        const compacted = provider.compactToolCallBatch([
            {
                id: "a",
                function: {
                    name: "list_dir",
                    arguments: { path: "src" },
                },
            },
            {
                id: "b",
                function: {
                    name: "grep_search",
                    arguments: {
                        query: "assets/level1.json",
                        isRegexp: false,
                        includePattern: "src/**",
                    },
                },
            },
            {
                id: "c",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/platformerGame.ts",
                        startLine: 1,
                        endLine: 120,
                    },
                },
            },
        ]);
        strict_1.default.equal(compacted.length, 1);
        strict_1.default.equal(compacted[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(compacted[0].function.arguments, {
            from: "assets/level1.json",
            to: "level1.json",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
    });
    test("guardrail fallback uses persisted intent when current turn intent is empty", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "";
        provider.persistedReplacementIntent = {
            from: "assets/hud.png",
            to: "hud.png",
        };
        const fallback = provider.buildGuardrailFallbackToolCalls("No further action needed. Let me know if you'd like anything else.", [
            {
                type: "function",
                function: {
                    name: "replace_in_files",
                    description: "Replace across files",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(fallback.length, 1);
        strict_1.default.equal(fallback[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(fallback[0].function.arguments, {
            from: "assets/hud.png",
            to: "hud.png",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
    });
    test("persists latest user goal across long exploratory chain within one request", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "";
        provider.persistedReplacementIntent = {
            from: "assets/bg.png",
            to: "bg.png",
        };
        const compacted = provider.compactToolCallBatch([
            { id: "1", function: { name: "list_dir", arguments: { path: "src" } } },
            {
                id: "2",
                function: {
                    name: "file_search",
                    arguments: { query: "**/*.ts", maxResults: 200 },
                },
            },
            {
                id: "3",
                function: {
                    name: "grep_search",
                    arguments: {
                        query: "assets/bg.png",
                        isRegexp: false,
                        includePattern: "src/**",
                        maxResults: 100,
                    },
                },
            },
            {
                id: "4",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/ui.ts",
                        startLine: 1,
                        endLine: 200,
                    },
                },
            },
            {
                id: "5",
                function: { name: "list_dir", arguments: { path: "assets" } },
            },
            {
                id: "6",
                function: {
                    name: "grep_search",
                    arguments: {
                        query: "assets/bg.png",
                        isRegexp: false,
                        includePattern: "**/*",
                        maxResults: 200,
                    },
                },
            },
            {
                id: "7",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/view.ts",
                        startLine: 1,
                        endLine: 240,
                    },
                },
            },
            {
                id: "8",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/view.ts",
                        oldString: "assets/bg.png",
                        newString: "bg.png",
                    },
                },
            },
            {
                id: "9",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "/tmp/local-qwen-replay-env/src/ui.ts",
                        oldString: "assets/bg.png",
                        newString: "bg.png",
                    },
                },
            },
        ]);
        strict_1.default.equal(compacted.length, 1);
        strict_1.default.equal(compacted[0].function.name, "replace_in_files");
        strict_1.default.deepEqual(compacted[0].function.arguments, {
            from: "assets/bg.png",
            to: "bg.png",
            includePattern: "**/*",
            maxFiles: 1500,
            caseSensitive: true,
            dryRun: false,
        });
    });
    test("forces diagnosis after build when model drifts into exploratory-only loop", () => {
        const originalDeep = process.env.LOCAL_QWEN_E2E_DEEP;
        delete process.env.LOCAL_QWEN_E2E_DEEP;
        try {
            const provider = createProvider();
            provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
            provider.buildFixBuildExecutedForTurn = true;
            provider.mutationCounterForTurn = 0;
            provider.buildFixForcedDiagnosisForTurn = false;
            const aligned = provider.alignToolCallsForLockedIntent([
                {
                    id: "1",
                    function: {
                        name: "read_file",
                        arguments: {
                            filePath: "src/platformerGame.ts",
                            startLine: 1,
                            endLine: 150,
                        },
                    },
                },
                {
                    id: "2",
                    function: {
                        name: "grep_search",
                        arguments: {
                            query: "player",
                            isRegexp: false,
                            includePattern: "src/**",
                        },
                    },
                },
            ], [
                {
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "Read file",
                        parameters: {},
                    },
                },
                {
                    type: "function",
                    function: {
                        name: "grep_search",
                        description: "Search text",
                        parameters: {},
                    },
                },
                {
                    type: "function",
                    function: {
                        name: "get_errors",
                        description: "Get workspace errors",
                        parameters: {},
                    },
                },
            ]);
            strict_1.default.equal(aligned.length, 1);
            strict_1.default.equal(aligned[0].function.name, "get_errors");
            strict_1.default.deepEqual(aligned[0].function.arguments, {});
        }
        finally {
            if (typeof originalDeep === "string") {
                process.env.LOCAL_QWEN_E2E_DEEP = originalDeep;
            }
            else {
                delete process.env.LOCAL_QWEN_E2E_DEEP;
            }
        }
    });
    test("preserves persisted user goal across per-turn dedupe resets", () => {
        const provider = createProvider();
        provider.persistedUserGoalForRequest = "run build and fix errors";
        provider.buildFixBuildExecutedForTurn = true;
        provider.prepareTurnDedupeState("run build and fix errors", "request-a");
        provider.prepareTurnDedupeState("run build and fix errors", "request-b");
        strict_1.default.equal(provider.persistedUserGoalForRequest, "run build and fix errors");
        strict_1.default.equal(provider.buildFixBuildExecutedForTurn, true);
    });
    test("prepareTurnDedupeState prefers locked intent over noisy latest user text", () => {
        const provider = createProvider();
        provider.prepareTurnDedupeState("please run build and fix the build errors", "noise-a");
        const firstKey = provider.activeDedupeRequestKey;
        provider.prepareTurnDedupeState("please run build and fix the build errors", "noise-b");
        const secondKey = provider.activeDedupeRequestKey;
        strict_1.default.equal(firstKey, secondKey);
    });
    test("treats 'No files found' as operational noise for locked intent", () => {
        const provider = createProvider();
        strict_1.default.equal(provider.looksLikeOperationalLookupNoise("No files found"), true);
    });
    test("treats replacement identical-input failure text as operational noise", () => {
        const provider = createProvider();
        strict_1.default.equal(provider.looksLikeOperationalLookupNoise("String replacement failed: Input and output are identical."), true);
    });
    test("getLockedUserIntentText ignores replacement-failure noise and keeps real request", () => {
        const provider = createProvider();
        const locked = provider.getLockedUserIntentText([
            {
                role: "user",
                content: "please run build and fix the build errors",
            },
            {
                role: "user",
                content: "String replacement failed: Input and output are identical.",
            },
        ]);
        strict_1.default.equal(locked, "please run build and fix the build errors");
    });
    test("sanitizes envelope context tail from locked intent candidate", () => {
        const provider = createProvider();
        const sanitized = provider.sanitizeIntentCandidate("please run build and fix the build errors Current context: date + terminals + noise");
        strict_1.default.equal(sanitized, "please run build and fix the build errors");
    });
    test("clears persisted lookup window state after each request", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "please run build and fix the build errors";
        provider.persistedLookupWindow = {
            requestKey: "please run build and fix the build errors",
            toolNames: ["run_in_terminal", "read_file"],
            usesLeft: 2,
            refreshedAt: Date.now(),
        };
        provider.lastLookupSelection = {
            requestKey: "please run build and fix the build errors",
            toolNames: ["run_in_terminal"],
            selectedAt: Date.now(),
        };
        provider.updatePersistedLookupWindowAfterTurn(new Set(["run_in_terminal"]));
        strict_1.default.equal(provider.persistedLookupWindow, undefined);
        strict_1.default.equal(provider.lastLookupSelection, undefined);
    });
    test("shouldRunFreshLookupSelection is true for non-empty requests", () => {
        const provider = createProvider();
        strict_1.default.equal(provider.shouldRunFreshLookupSelection("please run build and fix errors"), true);
        strict_1.default.equal(provider.shouldRunFreshLookupSelection(""), false);
    });
    test("compactContinuationMessages preserves latest assistant tool-call context", () => {
        const provider = createProvider();
        const messages = Array.from({ length: 30 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `message-${index}`,
            ...(index === 21
                ? {
                    tool_calls: [
                        {
                            id: "call-21",
                            function: {
                                name: "run_in_terminal",
                                arguments: { command: "npm run build" },
                            },
                        },
                    ],
                }
                : {}),
        }));
        const compacted = provider.compactContinuationMessages(messages);
        const keptToolCallMessage = compacted.find((entry) => entry.role === "assistant" && (entry.tool_calls?.length ?? 0) > 0);
        strict_1.default.ok(keptToolCallMessage);
    });
    test("does not suppress get_errors during unresolved build-fix loop", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "please run build and fix the build errors";
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.emittedReadOnlyToolFingerprintsForTurn.add("get_errors:{}");
        const suppressed = provider.shouldSuppressDuplicateToolCall("get_errors", {});
        strict_1.default.equal(suppressed, false);
    });
    test("labels terminal progress by actual command semantics", () => {
        const provider = createProvider();
        const buildLine = provider.formatToolProgressLine({
            id: "1",
            function: {
                name: "run_in_terminal",
                arguments: { command: "npm run compile" },
            },
        });
        const exploreLine = provider.formatToolProgressLine({
            id: "2",
            function: {
                name: "run_in_terminal",
                arguments: { command: "ls -la" },
            },
        });
        strict_1.default.equal(buildLine, "running verification command");
        strict_1.default.equal(exploreLine, "running shell exploration");
    });
    test("treats exploratory terminal command as non-action in build-fix action-first phase", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = "run build and fix errors";
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "run_in_terminal",
                    arguments: {
                        command: "ls -la",
                        explanation: "list files",
                        goal: "explore",
                        isBackground: false,
                        timeout: 0,
                    },
                },
            },
        ]);
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "run_in_terminal");
        strict_1.default.equal(enforced[0].function.arguments.command, "npm run build");
    });
    test("enforces action-first when exploratory command appears before build command", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "run_in_terminal",
                    arguments: {
                        command: "ls -la",
                        explanation: "inspect workspace",
                        goal: "context",
                        isBackground: false,
                        timeout: 0,
                    },
                },
            },
            {
                id: "2",
                function: {
                    name: "run_in_terminal",
                    arguments: {
                        command: "npm run build",
                        explanation: "run build",
                        goal: "reproduce errors",
                        isBackground: false,
                        timeout: 0,
                    },
                },
            },
        ]);
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "run_in_terminal");
        strict_1.default.equal(enforced[0].function.arguments.command, "npm run build");
    });
    test("compactToolCallBatch enforces action-first for single exploratory call", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        const compacted = provider.compactToolCallBatch([
            {
                id: "1",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "package.json",
                        startLine: 1,
                        endLine: 80,
                    },
                },
            },
        ]);
        strict_1.default.equal(compacted.length, 1);
        strict_1.default.equal(compacted[0].function.name, "run_in_terminal");
        strict_1.default.equal(compacted[0].function.arguments.command, "npm run build");
    });
    test("enforces action-first on first pre-build exploratory step in build-fix flow", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "src/platformerGame.ts",
                        startLine: 1,
                        endLine: 120,
                    },
                },
            },
        ]);
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "run_in_terminal");
        strict_1.default.equal(enforced[0].function.arguments.command, "npm run build");
    });
    test("does not inject intent-required tools (no guardrails)", () => {
        const originalDeep = process.env.LOCAL_QWEN_E2E_DEEP;
        delete process.env.LOCAL_QWEN_E2E_DEEP;
        try {
            const provider = createProvider();
            const selected = [
                {
                    type: "function",
                    function: {
                        name: "run_in_terminal",
                        description: "Run terminal command",
                        parameters: {},
                    },
                },
            ];
            const available = [
                ...selected,
                {
                    type: "function",
                    function: {
                        name: "get_errors",
                        description: "Get workspace errors",
                        parameters: {},
                    },
                },
                {
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "Read file",
                        parameters: {},
                    },
                },
                {
                    type: "function",
                    function: {
                        name: "apply_patch",
                        description: "Apply patch",
                        parameters: {},
                    },
                },
            ];
            const ensured = provider.ensureIntentRequiredTools(selected, available, "please run build and fix the build errors");
            const names = ensured.map((tool) => tool.function.name);
            strict_1.default.ok(names.includes("run_in_terminal"));
            strict_1.default.equal(names.length, 1);
        }
        finally {
            if (typeof originalDeep === "string") {
                process.env.LOCAL_QWEN_E2E_DEEP = originalDeep;
            }
            else {
                delete process.env.LOCAL_QWEN_E2E_DEEP;
            }
        }
    });
    test("forces diagnosis instead of pre-mutation build rerun in build-fix flow", () => {
        const originalDeep = process.env.LOCAL_QWEN_E2E_DEEP;
        delete process.env.LOCAL_QWEN_E2E_DEEP;
        try {
            const provider = createProvider();
            provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
            provider.buildFixBuildExecutedForTurn = true;
            provider.mutationCounterForTurn = 0;
            provider.buildFixForcedDiagnosisForTurn = false;
            const enforced = provider.enforceBuildFixPostBuildProgression([
                {
                    id: "1",
                    function: {
                        name: "run_in_terminal",
                        arguments: {
                            command: "npm run build",
                            explanation: "re-run build",
                            goal: "verify",
                            isBackground: false,
                            timeout: 0,
                        },
                    },
                },
            ], [
                {
                    type: "function",
                    function: {
                        name: "run_in_terminal",
                        description: "Run shell command",
                        parameters: {},
                    },
                },
                {
                    type: "function",
                    function: {
                        name: "get_errors",
                        description: "Get workspace errors",
                        parameters: {},
                    },
                },
            ]);
            strict_1.default.equal(enforced.length, 1);
            strict_1.default.equal(enforced[0].function.name, "get_errors");
            strict_1.default.deepEqual(enforced[0].function.arguments, {});
        }
        finally {
            if (typeof originalDeep === "string") {
                process.env.LOCAL_QWEN_E2E_DEEP = originalDeep;
            }
            else {
                delete process.env.LOCAL_QWEN_E2E_DEEP;
            }
        }
    });
    test("buildIntentAlignedFallbackToolCalls emits get_errors for post-build unresolved build-fix turn", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = false;
        const fallbackCalls = provider.buildIntentAlignedFallbackToolCalls([
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get workspace diagnostics",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(fallbackCalls.length, 1);
        strict_1.default.equal(fallbackCalls[0].function.name, "get_errors");
        strict_1.default.deepEqual(fallbackCalls[0].function.arguments, {});
    });
    test("buildIntentAlignedFallbackToolCalls emits run_in_terminal + get_errors pre-build when available", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = false;
        provider.mutationCounterForTurn = 0;
        const fallbackCalls = provider.buildIntentAlignedFallbackToolCalls([
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run shell command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get workspace diagnostics",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(fallbackCalls.length, 2);
        strict_1.default.equal(fallbackCalls[0].function.name, "run_in_terminal");
        strict_1.default.equal(fallbackCalls[1].function.name, "get_errors");
    });
    test("buildIntentAlignedFallbackToolCalls emits targeted read_file after forced diagnosis", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = true;
        provider.buildFixCandidateErrorFileForTurn = "src/platformerGame.ts";
        const fallbackCalls = provider.buildIntentAlignedFallbackToolCalls([
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(fallbackCalls.length, 1);
        strict_1.default.equal(fallbackCalls[0].function.name, "read_file");
        strict_1.default.equal(fallbackCalls[0].function.arguments.filePath, "src/platformerGame.ts");
    });
    test("enforceBuildFixActionFirst forces get_errors for post-build exploratory-only batch", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = false;
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "read_file",
                    arguments: {
                        filePath: "platformerGame.ts",
                        startLine: 1,
                        endLine: 120,
                    },
                },
            },
        ]);
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "get_errors");
        strict_1.default.deepEqual(enforced[0].function.arguments, {});
    });
    test("enforceBuildFixActionFirst escalates to targeted read_file after forced diagnosis", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = true;
        provider.buildFixCandidateErrorFileForTurn = "platformerGame.ts";
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "file_search",
                    arguments: { query: "src/**" },
                },
            },
        ]);
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "read_file");
        strict_1.default.equal(enforced[0].function.arguments.filePath, "platformerGame.ts");
    });
    test("augmentBuildFixWithWorkspaceDiagnostics appends get_errors to build terminal batch", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        const augmented = provider.augmentBuildFixWithWorkspaceDiagnostics([
            {
                id: "1",
                function: {
                    name: "run_in_terminal",
                    arguments: {
                        command: "npm run build",
                        isBackground: false,
                        timeout: 0,
                    },
                },
            },
        ], [
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run shell",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(augmented.length, 2);
        strict_1.default.equal(augmented[0].function.name, "run_in_terminal");
        strict_1.default.equal(augmented[1].function.name, "get_errors");
    });
    test("noteEmittedToolCall sets buildFixForcedDiagnosisForTurn after get_errors emitted in build-fix context", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = false;
        strict_1.default.strictEqual(provider.buildFixForcedDiagnosisForTurn, false);
        provider.noteEmittedToolCall("get_errors", {});
        strict_1.default.strictEqual(provider.buildFixForcedDiagnosisForTurn, true, "noteEmittedToolCall should set buildFixForcedDiagnosisForTurn when get_errors is emitted after build execution");
    });
    test("enforceBuildFixActionFirst does NOT prematurely set buildFixForcedDiagnosisForTurn when synthesizing get_errors", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = false;
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "read_file",
                    arguments: { filePath: "src/foo.ts", startLine: 1, endLine: 50 },
                },
            },
        ]);
        // Should synthesize get_errors
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "get_errors");
        // Flag must NOT be set yet — only noteEmittedToolCall should set it
        strict_1.default.strictEqual(provider.buildFixForcedDiagnosisForTurn, false, "flag must remain false until get_errors is actually emitted via noteEmittedToolCall");
    });
    test("enforceBuildFixActionFirst advances read window on repeated escalations", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = true;
        provider.buildFixCandidateErrorFileForTurn = "src/platformerGame.ts";
        provider.buildFixEscalatedReadEnd = 0;
        const exploratory = [
            {
                id: "1",
                function: {
                    name: "grep_search",
                    arguments: { query: "cameraX", isRegexp: false },
                },
            },
        ];
        // First escalation: 1-160
        const first = provider.enforceBuildFixActionFirst([...exploratory]);
        strict_1.default.equal(first.length, 1);
        strict_1.default.equal(first[0].function.name, "read_file");
        strict_1.default.equal(first[0].function.arguments.startLine, 1);
        strict_1.default.equal(first[0].function.arguments.endLine, 160);
        strict_1.default.equal(provider.buildFixEscalatedReadEnd, 160);
        // Second escalation: 161-320
        const second = provider.enforceBuildFixActionFirst([...exploratory]);
        strict_1.default.equal(second.length, 1);
        strict_1.default.equal(second[0].function.name, "read_file");
        strict_1.default.equal(second[0].function.arguments.startLine, 161);
        strict_1.default.equal(second[0].function.arguments.endLine, 320);
        strict_1.default.equal(provider.buildFixEscalatedReadEnd, 320);
    });
    test("enforceBuildFixActionFirst stops intercepting once escalated read cap reached", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = true;
        provider.buildFixCandidateErrorFileForTurn = "src/platformerGame.ts";
        provider.buildFixEscalatedReadEnd = 640; // cap reached
        const exploratory = [
            {
                id: "1",
                function: {
                    name: "grep_search",
                    arguments: { query: "cameraX", isRegexp: false },
                },
            },
        ];
        const result = provider.enforceBuildFixActionFirst([...exploratory]);
        // Should pass through unchanged
        strict_1.default.equal(result.length, 1);
        strict_1.default.equal(result[0].function.name, "grep_search");
    });
    test("build-fix mutation phase flags are set after full diagnosis+read cycle", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        // Simulate: build ran, get_errors emitted, then read_file escalated twice
        provider.noteEmittedToolCall("run_in_terminal", {
            command: "npm run build",
        });
        strict_1.default.ok(provider.buildFixBuildExecutedForTurn, "build marked as executed");
        provider.noteEmittedToolCall("get_errors", {});
        strict_1.default.ok(provider.buildFixForcedDiagnosisForTurn, "diagnosis flag set after get_errors");
        // Simulate escalation round 1: 1-160
        provider.buildFixEscalatedReadEnd = 160;
        // Now we're in the mutation phase: isBuildFixIntent(lockedIntent) && forcedDiagnosis && escalatedReadEnd >= 160
        strict_1.default.ok(provider.isBuildFixIntent(provider.currentLockedIntentForTurn));
        strict_1.default.strictEqual(provider.buildFixForcedDiagnosisForTurn, true);
        strict_1.default.ok(provider.buildFixEscalatedReadEnd >= 160, "read end >= 160");
        // Mutation (apply_patch) should reset escalation counter
        provider.noteEmittedToolCall("apply_patch", {
            input: "*** Begin Patch\n*** End Patch",
        });
        strict_1.default.strictEqual(provider.buildFixEscalatedReadEnd, 0, "escalated read end resets after mutation");
        strict_1.default.strictEqual(provider.buildFixForcedDiagnosisForTurn, false, "forced diagnosis flag clears after mutation");
    });
    test("preferPatchStyleMutationCalls converts replace_string_in_file to apply_patch for build-fix intent", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        const converted = provider.preferPatchStyleMutationCalls([
            {
                id: "1",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "src/platformerGame.ts",
                        oldString: "let cameraX = 0;",
                        newString: "let mouse = { x: 0, y: 0, down: false };",
                    },
                },
            },
        ], [
            {
                type: "function",
                function: {
                    name: "apply_patch",
                    description: "Apply patch",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(converted.length, 1);
        strict_1.default.equal(converted[0].function.name, "apply_patch");
        strict_1.default.match(converted[0].function.arguments.input, /\*\*\* Begin Patch/);
        strict_1.default.match(converted[0].function.arguments.input, /\*\*\* Update File: src\/platformerGame\.ts/);
    });
    test("preferPatchStyleMutationCalls leaves replace_string_in_file unchanged when apply_patch is unavailable", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        const converted = provider.preferPatchStyleMutationCalls([
            {
                id: "1",
                function: {
                    name: "replace_string_in_file",
                    arguments: {
                        filePath: "src/platformerGame.ts",
                        oldString: "let cameraX = 0;",
                        newString: "let mouse = { x: 0, y: 0, down: false };",
                    },
                },
            },
        ], [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ]);
        strict_1.default.equal(converted.length, 1);
        strict_1.default.equal(converted[0].function.name, "replace_string_in_file");
    });
    test("extracts candidate error file path from get_errors-style context", () => {
        const provider = createProvider();
        const extracted = provider.extractRecentBuildFixErrorFilePath([
            {
                role: "user",
                content: "Checked workspace, 13 problems found in platformerGame.ts",
            },
        ]);
        strict_1.default.equal(extracted, "platformerGame.ts");
    });
    test("extractRecentBuildFixErrorFilePath prefers workspace source over node_modules stacktrace paths", () => {
        const provider = createProvider();
        const extracted = provider.extractRecentBuildFixErrorFilePath([
            {
                role: "assistant",
                content: [
                    "Checked workspace, 13 problems found in src/platformerGame.ts",
                    "at handleIncomingPacket (/Users/me/project/node_modules/esbuild/lib/main.js:603:9)",
                ].join("\n"),
            },
        ]);
        strict_1.default.equal(extracted, "src/platformerGame.ts");
    });
    test("extractRecentBuildFixErrorFilePath ignores third-party-only paths", () => {
        const provider = createProvider();
        const extracted = provider.extractRecentBuildFixErrorFilePath([
            {
                role: "assistant",
                content: "at handleIncomingPacket (/Users/me/project/node_modules/esbuild/lib/main.js:603:9)",
            },
        ]);
        strict_1.default.equal(extracted, "");
    });
    test("enforceBuildFixActionFirst ignores third-party candidate and forces get_errors", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
        provider.buildFixBuildExecutedForTurn = true;
        provider.mutationCounterForTurn = 0;
        provider.buildFixForcedDiagnosisForTurn = true;
        provider.buildFixCandidateErrorFileForTurn = "node_modules/esbuild/lib/main.js";
        const enforced = provider.enforceBuildFixActionFirst([
            {
                id: "1",
                function: {
                    name: "read_file",
                    arguments: { filePath: "node_modules/esbuild/lib/main.js" },
                },
            },
        ]);
        strict_1.default.equal(enforced.length, 1);
        strict_1.default.equal(enforced[0].function.name, "get_errors");
        strict_1.default.deepEqual(enforced[0].function.arguments, {});
    });
    test("escalates repeated diagnosis-only loop to targeted read_file", () => {
        const originalDeep = process.env.LOCAL_QWEN_E2E_DEEP;
        delete process.env.LOCAL_QWEN_E2E_DEEP;
        try {
            const provider = createProvider();
            provider.currentLockedIntentForTurn = HUMAN_BUILD_FIX_REQUEST;
            provider.buildFixBuildExecutedForTurn = true;
            provider.mutationCounterForTurn = 0;
            provider.buildFixForcedDiagnosisForTurn = true;
            provider.buildFixCandidateErrorFileForTurn = "platformerGame.ts";
            const enforced = provider.enforceBuildFixPostBuildProgression([
                {
                    id: "1",
                    function: {
                        name: "get_errors",
                        arguments: {},
                    },
                },
            ], [
                {
                    type: "function",
                    function: {
                        name: "get_errors",
                        description: "Get workspace errors",
                        parameters: {},
                    },
                },
                {
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "Read file",
                        parameters: {},
                    },
                },
            ]);
            strict_1.default.equal(enforced.length, 1);
            strict_1.default.equal(enforced[0].function.name, "read_file");
            strict_1.default.equal(enforced[0].function.arguments.filePath, "platformerGame.ts");
        }
        finally {
            if (typeof originalDeep === "string") {
                process.env.LOCAL_QWEN_E2E_DEEP = originalDeep;
            }
            else {
                delete process.env.LOCAL_QWEN_E2E_DEEP;
            }
        }
    });
    test("suppresses persisted replacement intent for missing-resource (404) intents", () => {
        const provider = createProvider();
        provider.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/level1.json 404 (Not Found)";
        provider.persistedReplacementIntent = {
            from: "assets/level1.json",
            to: "level1.json",
        };
        const compacted = provider.compactToolCallBatch([
            {
                id: "1",
                function: {
                    name: "file_search",
                    arguments: { query: "**/*.ts", maxResults: 50 },
                },
            },
        ]);
        strict_1.default.equal(compacted.length, 1);
        strict_1.default.equal(compacted[0].function.name, "file_search");
    });
    test("applyMissingResourceProbeSubset forces one grep retry before verification after grep miss", () => {
        const provider = createProvider();
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "list_dir",
                    description: "List directory",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "open_simple_browser",
                    description: "Open browser",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "grep_search",
                    description: "Search text",
                    parameters: {},
                },
            },
        ];
        const messages = [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "0 matches in 0 files",
            },
        ];
        const result = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", messages, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)");
        const names = result.map((tool) => tool.function.name);
        strict_1.default.deepEqual(names, ["grep_search"]);
    });
    test("applyMissingResourceProbeSubset forces verification tools after refined grep also misses", () => {
        const provider = createProvider();
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "list_dir",
                    description: "List directory",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "open_simple_browser",
                    description: "Open browser",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "grep_search",
                    description: "Search text",
                    parameters: {},
                },
            },
        ];
        const messages = [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "0 matches in 0 files",
            },
        ];
        const first = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", messages, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)");
        strict_1.default.deepEqual(first.map((tool) => tool.function.name), ["grep_search"]);
        const second = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", messages, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)");
        const names = second.map((tool) => tool.function.name);
        strict_1.default.deepEqual(names, ["run_in_terminal", "get_errors"]);
    });
    test("applyMissingResourceProbeSubset forces immediate verification after grep hit", () => {
        const provider = createProvider();
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "list_dir",
                    description: "List directory",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "open_simple_browser",
                    description: "Open browser",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "grep_search",
                    description: "Search text",
                    parameters: {},
                },
            },
        ];
        const messages = [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "6 matches in 2 files",
            },
        ];
        const result = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", messages, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)");
        const names = result.map((tool) => tool.function.name);
        strict_1.default.deepEqual(names, ["run_in_terminal", "get_errors"]);
    });
    test("applyMissingResourceProbeSubset treats 'N results' grep output as hit and blocks read loops", () => {
        const provider = createProvider();
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "list_dir",
                    description: "List directory",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "grep_search",
                    description: "Search text",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "Searched for text explosion.png in src/**, 2 results",
            },
        ], "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)");
        const names = result.map((tool) => tool.function.name);
        strict_1.default.deepEqual(names, ["run_in_terminal", "get_errors"]);
    });
    test("applyMissingResourceProbeSubset still forces verification after grep hit when intent text is absent", () => {
        const provider = createProvider();
        provider.state.missingResourceOptionalExtensionRetryUsedForTurn = true;
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "list_dir",
                    description: "List directory",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "open_simple_browser",
                    description: "Open browser",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "", [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "6 matches in 2 files",
            },
        ], "");
        strict_1.default.deepEqual(result.map((tool) => tool.function.name), ["run_in_terminal", "get_errors"]);
    });
    test("buildMissingResourceVerificationGateHint emits cut-short verification directive", () => {
        const provider = createProvider();
        const availableTools = [
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
        ];
        const hint = provider.buildMissingResourceVerificationGateHint(availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "no matches found",
            },
        ]);
        strict_1.default.match(hint, /this error shouldn't be happening, I need to cut short my investigation from going any deeper and test further/i);
        strict_1.default.match(hint, /Run verification now/i);
    });
    test("buildMissingResourcePostHitVerificationHint requests full verification sequence", () => {
        const provider = createProvider();
        const availableTools = [
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_focus_window",
                    description: "Focus window",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_take_screenshot",
                    description: "Take screenshot",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_ocr_find_text",
                    description: "OCR",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_gui_click",
                    description: "Click",
                    parameters: {},
                },
            },
        ];
        const hint = provider.buildMissingResourcePostHitVerificationHint(availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "6 matches in 2 files",
            },
        ]);
        strict_1.default.match(hint, /project-appropriate command/i);
        strict_1.default.match(hint, /run_in_terminal/i);
        strict_1.default.match(hint, /Before any edit\/list\/read/i);
        strict_1.default.match(hint, /focus_window to foreground terminal|focus_window to bring terminal/i);
        strict_1.default.match(hint, /OCR served URL text/i);
        strict_1.default.match(hint, /gui_click/i);
    });
    test("applyMissingResourceProbeSubset prioritizes machine verification tools when available", () => {
        const provider = createProvider();
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "run_vscode_command",
                    description: "Open URL via VS Code command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_list_windows",
                    description: "List windows",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_focus_window",
                    description: "Focus window",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_gui_click",
                    description: "Click",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_take_screenshot",
                    description: "Take screenshot",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "localQwen_ocr_find_text",
                    description: "OCR",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyMissingResourceProbeSubset(selectedTools, availableTools, "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)", [
            {
                role: "tool",
                tool_name: "grep_search",
                content: "6 matches in 2 files",
            },
        ], "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)");
        strict_1.default.deepEqual(result.map((tool) => tool.function.name), [
            "run_in_terminal",
            "localQwen_list_windows",
            "localQwen_focus_window",
            "localQwen_take_screenshot",
            "localQwen_ocr_find_text",
            "localQwen_gui_click",
            "run_vscode_command",
            "get_errors",
        ]);
    });
    test("normalizeToolInput scopes grep_search to source include pattern for runtime asset URL", () => {
        const provider = createProvider();
        const normalized = provider.normalizeToolInput("grep_search", {
            query: "http://localhost:3000/assets/PNG/explosion.png",
            isRegexp: false,
        });
        strict_1.default.equal(normalized.includePattern, "src/**");
    });
    test("normalizeToolInput scopes grep_search to source include pattern for log-like query", () => {
        const provider = createProvider();
        const normalized = provider.normalizeToolInput("grep_search", {
            query: "/Users/alexwaldmann/Library/Application Support/Code/User/workspaceStorage/abc/content.txt",
            isRegexp: false,
        });
        strict_1.default.equal(normalized.includePattern, "src/**");
    });
    test("normalizeToolInput preserves explicit grep includePattern", () => {
        const provider = createProvider();
        const normalized = provider.normalizeToolInput("grep_search", {
            query: "http://localhost:3000/assets/PNG/explosion.png",
            isRegexp: false,
            includePattern: "docs/**",
        });
        strict_1.default.equal(normalized.includePattern, "docs/**");
    });
    test("normalizeToolInput clamps broad includePattern to source scope during missing-resource retry", () => {
        const provider = createProvider();
        provider.state.missingResourceOptionalExtensionRetryUsedForTurn = true;
        const normalized = provider.normalizeToolInput("grep_search", {
            query: "explosion.png",
            isRegexp: true,
            includePattern: "**/*",
            includeIgnoredFiles: true,
        });
        strict_1.default.equal(normalized.includePattern, "src/**");
    });
    test("normalizeToolInput relaxes extension on retry by switching to regex", () => {
        const provider = createProvider();
        provider.state.missingResourceOptionalExtensionRetryUsedForTurn = true;
        const normalized = provider.normalizeToolInput("grep_search", {
            query: "explosion.png",
            isRegexp: false,
        });
        strict_1.default.equal(normalized.isRegexp, true);
        strict_1.default.match(String(normalized.query), /explosion\(\?:\\\.png\)\?/);
    });
    test("normalizeToolInput does not force showTerminal for runtime verification boot command", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)";
        const normalized = provider.normalizeToolInput("run_in_terminal", {
            command: "npm run dev",
            isBackground: true,
        });
        strict_1.default.equal(normalized.showTerminal, false);
    });
    test("normalizeToolInput does not force showTerminal for non-runtime terminal command", () => {
        const provider = createProvider();
        const normalized = provider.normalizeToolInput("run_in_terminal", {
            command: "npm run compile",
            isBackground: false,
        });
        strict_1.default.equal(normalized.showTerminal, false);
    });
    test("computeAdaptiveReasoningStage escalates with tool-result density", () => {
        const provider = createProvider();
        const stage = provider.computeAdaptiveReasoningStage([
            { role: "user", content: "Investigate runtime error" },
            { role: "tool", tool_name: "grep_search", content: "1 match" },
            { role: "tool", tool_name: "read_file", content: "Read file" },
            { role: "tool", tool_name: "get_errors", content: "No errors" },
            { role: "tool", tool_name: "run_in_terminal", content: "build output" },
        ]);
        strict_1.default.equal(stage, 3);
    });
    test("buildAdaptiveReasoningProtocolMessage instructs explicit simulation for non-thinking models", () => {
        const provider = createProvider();
        const message = provider.buildAdaptiveReasoningProtocolMessage(2, false);
        strict_1.default.match(message, /simulate deliberate reasoning explicitly/i);
        strict_1.default.match(message, /teammate-style communication/i);
        strict_1.default.match(message, /workbench\.action\.terminal\.focus/i);
        strict_1.default.match(message, /never substitute ls\/find\/tree\/grep\/cat as runtime verification/i);
    });
    test("applyPostMutationVerificationSubset forces verification tools when mutation is unverified", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 1;
        provider.state.verificationCheckpointForTurn = 0;
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyPostMutationVerificationSubset(selectedTools, availableTools, []);
        strict_1.default.deepEqual(result.map((tool) => tool.function.name), ["run_in_terminal", "get_errors"]);
    });
    test("applyPostMutationVerificationSubset falls back to source evidence tools when verification tools are unavailable", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 2;
        provider.state.verificationCheckpointForTurn = 1;
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            {
                type: "function",
                function: {
                    name: "open_simple_browser",
                    description: "Open browser",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "grep_search",
                    description: "Search",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyPostMutationVerificationSubset(selectedTools, availableTools, []);
        strict_1.default.deepEqual(result.map((tool) => tool.function.name), ["grep_search", "read_file"]);
    });
    test("getBlockedToolCallReason allows exploratory run_in_terminal to keep agent loop alive", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 2;
        provider.state.verificationCheckpointForTurn = 1;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "find . -name '*.png'",
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason allows verification run_in_terminal command during post-mutation gate", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 3;
        provider.state.verificationCheckpointForTurn = 1;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run compile && npm test && npm run test:extension",
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason allows repeated verification run_in_terminal command during post-mutation gate", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 3;
        provider.state.verificationCheckpointForTurn = 1;
        provider.noteEmittedToolCall("run_in_terminal", {
            command: "npm run dev",
            isBackground: true,
        });
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason allows non-verification run_in_terminal command during gate", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 2;
        provider.state.verificationCheckpointForTurn = 0;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "echo hello",
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason allows read_file during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "read_file",
                arguments: {
                    filePath: "src/platformerGame.ts",
                    startLine: 1,
                    endLine: 80,
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason blocks duplicate run_in_terminal verification command during missing-resource gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        provider.noteEmittedToolCall("run_in_terminal", {
            command: "npm run dev",
            isBackground: true,
        });
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                },
            },
        });
        strict_1.default.match(String(reason), /loop detected|repeated boot\/focus calls/i);
        strict_1.default.match(String(reason), /next step: call await_terminal or get_terminal_output/i);
    });
    test("getBlockedToolCallReason blocks run_in_terminal verification boot before terminal focus in missing-resource gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                    isBackground: true,
                },
            },
        });
        strict_1.default.match(String(reason), /requires terminal focus before boot/i);
    });
    test("getBlockedToolCallReason allows run_in_terminal verification boot after terminal focus in missing-resource gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        provider.noteEmittedToolCall("run_vscode_command", {
            commandId: "workbench.action.terminal.focus",
            args: [],
        });
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                    isBackground: true,
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason allows run_vscode_command terminal focus during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_vscode_command",
                arguments: {
                    commandId: "workbench.action.terminal.focus",
                    args: [],
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason blocks unrelated run_vscode_command during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_vscode_command",
                arguments: {
                    commandId: "workbench.action.openWalkthrough",
                    args: [],
                },
            },
        });
        strict_1.default.match(String(reason), /blocks unrelated vs code commands|only use run_vscode_command/i);
    });
    test("getBlockedToolCallReason blocks duplicate run_vscode_command terminal focus during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.noteEmittedToolCall("run_vscode_command", {
            commandId: "workbench.action.terminal.focus",
            args: [],
        });
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_vscode_command",
                arguments: {
                    commandId: "workbench.action.terminal.toggleTerminal",
                    args: [],
                },
            },
        });
        strict_1.default.match(String(reason), /toggle is blocked|blocked/i);
    });
    test("getBlockedToolCallReason allows get_errors during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "get_errors",
                arguments: {},
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getBlockedToolCallReason allows localQwen_take_screenshot during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "localQwen_take_screenshot",
                arguments: {
                    windowTitle: "Extension Development Host",
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("noteEmittedToolCall clears missing-resource verification gate after verification tool", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.noteEmittedToolCall("get_errors", {});
        strict_1.default.equal(provider.state.missingResourceVerificationGateActiveForTurn, false);
    });
    test("noteEmittedToolCall keeps missing-resource verification gate active after run_in_terminal", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.noteEmittedToolCall("run_in_terminal", {
            command: "npm run build",
        });
        strict_1.default.equal(provider.state.missingResourceVerificationGateActiveForTurn, true);
    });
    test("noteEmittedToolCall keeps missing-resource verification gate active after await_terminal in runtime flow", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)";
        provider.noteEmittedToolCall("await_terminal", {
            id: "term-1",
            timeout: 1500,
        });
        strict_1.default.equal(provider.state.missingResourceVerificationGateActiveForTurn, true);
    });
    test("noteEmittedToolCall keeps missing-resource verification gate active after get_terminal_output in runtime flow", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)";
        provider.noteEmittedToolCall("get_terminal_output", {
            id: "term-1",
        });
        strict_1.default.equal(provider.state.missingResourceVerificationGateActiveForTurn, true);
    });
    test("getBlockedToolCallReason blocks duplicate run_in_terminal verification boot when request-scoped boot marker is set", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        provider.state.persistedRuntimeVerificationBootIssuedForRequest = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                    isBackground: true,
                },
            },
        });
        strict_1.default.match(String(reason), /loop detected|repeated boot\/focus calls/i);
    });
    test("getBlockedToolCallReason blocks duplicate run_in_terminal verification boot during cooldown window", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        provider.state.persistedRuntimeVerificationBootCommand = "npm run dev";
        provider.state.persistedRuntimeVerificationLastBootAtMs = Date.now();
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                    isBackground: true,
                },
            },
        });
        strict_1.default.match(String(reason), /loop detected|repeated boot\/focus calls/i);
    });
    test("noteEmittedToolCall clears request-scoped runtime boot marker after code mutation", () => {
        const provider = createProvider();
        provider.state.persistedRuntimeVerificationBootIssuedForRequest = true;
        provider.noteEmittedToolCall("replace_string_in_file", {
            filePath: "src/platformerGame.ts",
            oldString: "old",
            newString: "new",
        });
        strict_1.default.equal(provider.state.persistedRuntimeVerificationBootIssuedForRequest, false);
        strict_1.default.equal(provider.state.persistedRuntimeVerificationBootCommand, "");
        strict_1.default.equal(provider.state.persistedRuntimeVerificationLastBootAtMs, 0);
    });
    test("getBlockedToolCallReason blocks screenshot evidence before terminal focus in runtime verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)";
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "take_screenshot",
                arguments: {},
            },
        });
        strict_1.default.match(String(reason), /requires terminal focus/i);
    });
    test("getBlockedToolCallReason allows screenshot evidence after explicit terminal focus window", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)";
        provider.noteEmittedToolCall("run_vscode_command", {
            commandId: "workbench.action.terminal.focus,",
            args: [],
        });
        provider.noteEmittedToolCall("focus_window", {
            windowTitle: "Terminal",
        });
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "take_screenshot",
                arguments: {},
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("noteEmittedToolCall clears missing-resource verification gate after screenshot evidence in runtime flow", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/assets/PNG/explosion.png 404 (Not Found)";
        provider.noteEmittedToolCall("localQwen_take_screenshot", {
            windowTitle: "Extension Development Host",
        });
        strict_1.default.equal(provider.state.missingResourceVerificationGateActiveForTurn, false);
    });
    test("isVerificationTool does not treat open_simple_browser as verification", () => {
        const provider = createProvider();
        const isVerification = provider.isVerificationTool("open_simple_browser", {
            url: "http://localhost:3000",
        });
        strict_1.default.equal(isVerification, false);
    });
    test("getBlockedToolCallReason blocks open_simple_browser during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "open_simple_browser",
                arguments: {
                    url: "http://localhost:3000",
                },
            },
        });
        strict_1.default.match(String(reason), /open_simple_browser is blocked/i);
    });
    test("buildPlainTextFallbackForBlockedToolCall returns undefined for non-blocked tools", () => {
        const provider = createProvider();
        provider.state.currentLockedIntentForTurn = "GET http://localhost:3000/PNG/explosion.png 404";
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const text = provider.buildPlainTextFallbackForBlockedToolCall({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "ls -la assets",
                },
            },
        });
        strict_1.default.equal(text, undefined);
    });
    test("buildPlainTextFallbackForBlockedToolCall returns concise next step for blocked open_simple_browser", () => {
        const provider = createProvider();
        provider.state.currentLockedIntentForTurn = "GET http://localhost:3000/PNG/explosion.png 404";
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const text = provider.buildPlainTextFallbackForBlockedToolCall({
            function: {
                name: "open_simple_browser",
                arguments: {
                    url: "http://localhost:3000",
                },
            },
        });
        strict_1.default.match(String(text), /next step: run_in_terminal/i);
        strict_1.default.match(String(text), /await_terminal\/get_terminal_output/i);
    });
    test("buildPlainTextFallbackForBlockedToolCall for duplicate runtime boot tells model to read terminal output next", () => {
        const provider = createProvider();
        provider.state.currentLockedIntentForTurn = "GET http://localhost:3000/PNG/explosion.png 404";
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const text = provider.buildPlainTextFallbackForBlockedToolCall({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "npm run dev",
                },
            },
        }, "Runtime verification loop detected: duplicate boot/focus call blocked.");
        strict_1.default.match(String(text), /await_terminal|get_terminal_output/i);
        strict_1.default.doesNotMatch(String(text), /next step: run_in_terminal/i);
    });
    test("buildPlainTextFallbackForBlockedToolCall for command mismatch tells model to run verification command", () => {
        const provider = createProvider();
        provider.state.currentLockedIntentForTurn = "GET http://localhost:3000/PNG/explosion.png 404";
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const text = provider.buildPlainTextFallbackForBlockedToolCall({
            function: {
                name: "run_in_terminal",
                arguments: {
                    command: "echo hello",
                },
            },
        }, "Verification gate active: run_in_terminal command is not the verification command.");
        strict_1.default.match(String(text), /next step: run_in_terminal/i);
        strict_1.default.match(String(text), /await_terminal\/get_terminal_output/i);
    });
    test("isVerificationTool treats run_vscode_command vscode.open with URL as verification", () => {
        const provider = createProvider();
        const isVerification = provider.isVerificationTool("run_vscode_command", {
            commandId: "vscode.open",
            args: ["http://localhost:3000/"],
        });
        strict_1.default.equal(isVerification, true);
    });
    test("getBlockedToolCallReason allows run_vscode_command vscode.open URL during missing-resource verification gate", () => {
        const provider = createProvider();
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const reason = provider.getBlockedToolCallReason({
            function: {
                name: "run_vscode_command",
                arguments: {
                    commandId: "vscode.open",
                    args: ["http://localhost:3000/"],
                },
            },
        });
        strict_1.default.equal(reason, undefined);
    });
    test("getPreferredVerificationTerminalInvocation prefers runtime dev flow for missing-resource intent", () => {
        const provider = createProvider();
        provider.state.currentLockedIntentForTurn =
            "GET http://localhost:3000/PNG/explosion.png 404 (Not Found)";
        provider.state.missingResourceVerificationGateActiveForTurn = true;
        const invocation = provider.getPreferredVerificationTerminalInvocation();
        strict_1.default.equal(invocation.command, "npm run dev");
        strict_1.default.equal(invocation.isBackground, true);
    });
    test("getPreferredVerificationTerminalInvocation prefers compile+test for build-fix intent", () => {
        const provider = createProvider();
        provider.state.currentLockedIntentForTurn = "fix compile errors and run tests";
        provider.state.missingResourceVerificationGateActiveForTurn = false;
        const invocation = provider.getPreferredVerificationTerminalInvocation();
        strict_1.default.match(invocation.command, /npm run compile && npm test|npm run build && npm test|npm test|npm run build/i);
        strict_1.default.equal(typeof invocation.isBackground, "boolean");
    });
    test("applyPostMutationVerificationSubset prioritizes run_in_terminal and get_errors only", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 1;
        provider.state.verificationCheckpointForTurn = 0;
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
        ];
        const availableTools = [
            ...selectedTools,
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_errors",
                    description: "Get diagnostics",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "open_simple_browser",
                    description: "Open browser",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyPostMutationVerificationSubset(selectedTools, availableTools, []);
        strict_1.default.deepEqual(result.map((tool) => tool.function.name), ["run_in_terminal", "get_errors"]);
    });
    test("applyPostMutationVerificationSubset prioritizes runtime/system verification tools to the front", () => {
        const provider = createProvider();
        provider.state.mutationCounterForTurn = 2;
        provider.state.verificationCheckpointForTurn = 0;
        const selectedTools = [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read file",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "get_terminal_output",
                    description: "Get terminal output",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "take_screenshot",
                    description: "Take screenshot",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "run_in_terminal",
                    description: "Run command",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "await_terminal",
                    description: "Await terminal",
                    parameters: {},
                },
            },
            {
                type: "function",
                function: {
                    name: "analyze_image",
                    description: "Analyze image",
                    parameters: {},
                },
            },
        ];
        const result = provider.applyPostMutationVerificationSubset(selectedTools, selectedTools, []);
        const names = result.map((tool) => tool.function.name);
        strict_1.default.equal(names[0], "run_in_terminal");
        strict_1.default.equal(names[1], "await_terminal");
        strict_1.default.equal(names[2], "get_terminal_output");
        strict_1.default.ok(names.indexOf("take_screenshot") < names.indexOf("analyze_image"));
        strict_1.default.ok(!names.includes("read_file"));
    });
});
//# sourceMappingURL=localLanguageModelProvider.test.js.map