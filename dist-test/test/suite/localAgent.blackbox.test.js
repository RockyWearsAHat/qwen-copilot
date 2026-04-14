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
const vscode = __importStar(require("vscode"));
const localAgent_1 = require("../../src/agent/localAgent");
function isPlanningRequest(request) {
    const system = request?.messages?.[0]?.content;
    return (typeof system === "string" &&
        system.includes("You are a planning assistant") &&
        system.includes("output ONLY a valid JSON array"));
}
function planningOk() {
    return {
        message: {
            role: "assistant",
            content: "[]",
            tool_calls: [],
        },
    };
}
function createToken(isCancelled = false) {
    return {
        isCancellationRequested: isCancelled,
        onCancellationRequested: (listener) => {
            if (isCancelled) {
                listener();
            }
            return { dispose: () => { } };
        },
    };
}
function withLocalQwenConfig(overrides) {
    const original = vscode.workspace.getConfiguration;
    Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: (_section) => ({
            get: (key, fallback) => Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback,
        }),
    });
    return () => {
        Object.defineProperty(vscode.workspace, "getConfiguration", {
            configurable: true,
            value: original,
        });
    };
}
suite("LocalAgentRunner black-box", () => {
    test("tools command lists discovered executable tools", async () => {
        const restoreConfig = withLocalQwenConfig({});
        const streamMarkdown = [];
        const registry = {
            refreshCalls: 0,
            async refresh() {
                this.refreshCalls += 1;
            },
            getExecutableTools() {
                return [
                    { name: "read_file", description: "", parameters: {} },
                    { name: "list_dir", description: "", parameters: {} },
                ];
            },
            async execute() {
                throw new Error("execute should not be called in tools mode");
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        runner.llmClient = {
            chat: async () => {
                throw new Error("chat should not be called in tools mode");
            },
        };
        const stream = {
            markdown: (value) => streamMarkdown.push(value),
            progress: () => { },
        };
        try {
            await runner.handleRequest({ command: "tools", prompt: "show tools" }, stream, createToken());
            strict_1.default.equal(registry.refreshCalls, 1);
            strict_1.default.equal(streamMarkdown.length, 1);
            strict_1.default.match(streamMarkdown[0], /Discovered tools:/);
            strict_1.default.match(streamMarkdown[0], /read_file/);
            strict_1.default.match(streamMarkdown[0], /list_dir/);
        }
        finally {
            restoreConfig();
        }
    });
    test("returns assistant final answer when model responds without tool calls", async () => {
        const restoreConfig = withLocalQwenConfig({
            endpoint: "http://localhost:11434",
            model: "qwen2.5:32b",
            maxAgentSteps: 4,
            temperature: 0.2,
        });
        const markdown = [];
        const progress = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute() {
                return { ok: true };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        const calls = [];
        runner.llmClient = {
            chat: async (request) => {
                calls.push(request);
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Done successfully.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: (value) => progress.push(value),
        };
        try {
            await runner.handleRequest({ prompt: "implement change" }, stream, createToken());
            const executionCalls = calls.filter((call) => !isPlanningRequest(call));
            strict_1.default.equal(executionCalls.length, 1);
            strict_1.default.equal(executionCalls[0].tools.length, 1);
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Done successfully."]);
        }
        finally {
            restoreConfig();
        }
    });
    test("falls back to tool-less mode when model rejects tools", async () => {
        const restoreConfig = withLocalQwenConfig({
            model: "model-without-tools",
            maxAgentSteps: 3,
        });
        const progress = [];
        const markdown = [];
        const outputLines = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute() {
                return { ok: true };
            },
        };
        const output = {
            appendLine: (line) => outputLines.push(line),
        };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        const requests = [];
        let first = true;
        runner.llmClient = {
            chat: async (request) => {
                requests.push(request);
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                if (first) {
                    first = false;
                    throw new Error("selected model does not support tools");
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Fallback answer",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: (value) => progress.push(value),
        };
        try {
            await runner.handleRequest({ prompt: "read file" }, stream, createToken());
            const executionRequests = requests.filter((call) => !isPlanningRequest(call));
            strict_1.default.equal(executionRequests.length, 2);
            strict_1.default.equal(executionRequests[0].tools.length, 1);
            strict_1.default.equal(executionRequests[1].tools.length, 0);
            strict_1.default.ok(progress.some((line) => /retrying without tool calls/i.test(line)));
            strict_1.default.ok(outputLines.some((line) => /does not support tools/i.test(line)));
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Fallback answer"]);
        }
        finally {
            restoreConfig();
        }
    });
    test("tool-less model can still request tools via tagged JSON fallback", async () => {
        const restoreConfig = withLocalQwenConfig({
            endpoint: "http://localhost:11434",
            model: "model-without-tools",
            maxAgentSteps: 4,
            temperature: 0.2,
        });
        const markdown = [];
        const progress = [];
        const outputLines = [];
        const executed = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute(name, args) {
                executed.push({ name, args });
                return { content: "file text" };
            },
        };
        const output = {
            appendLine: (line) => outputLines.push(line),
        };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        let call = 0;
        runner.llmClient = {
            chat: async (request) => {
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                call += 1;
                if (call === 1) {
                    // First call errors because tools were attached.
                    throw new Error("selected model does not support tools");
                }
                if (call === 2) {
                    // Tool-less retry: request a tool via tagged JSON.
                    return {
                        message: {
                            role: "assistant",
                            content: '<local_qwen_tool_call>{"tool_calls":[{"name":"read_file","arguments":{"filePath":"/tmp/a","startLine":1,"endLine":5}}]}</local_qwen_tool_call>',
                            tool_calls: [],
                        },
                    };
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Done after reading.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: (value) => progress.push(value),
        };
        try {
            await runner.handleRequest({ prompt: "read a file then answer" }, stream, createToken());
            strict_1.default.equal(executed.length, 1);
            strict_1.default.equal(executed[0].name, "read_file");
            strict_1.default.deepEqual(executed[0].args, { filePath: "/tmp/a", startLine: 1, endLine: 5 });
            strict_1.default.ok(progress.some((line) => /retrying without tool calls/i.test(line)));
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Done after reading."]);
            strict_1.default.ok(outputLines.some((line) => /parsed 1 tool call\(s\) from tagged text fallback/i.test(line)));
        }
        finally {
            restoreConfig();
        }
    });
    test("propagates cancellation signal to model chat call", async () => {
        const restoreConfig = withLocalQwenConfig({
            endpoint: "http://localhost:11434",
            model: "qwen2.5:32b",
            maxAgentSteps: 2,
            temperature: 0.2,
        });
        let cancelListener;
        const cancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: (listener) => {
                cancelListener = listener;
                return { dispose: () => { } };
            },
        };
        const markdown = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute() {
                return { ok: true };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        const observedAbortStates = [];
        runner.llmClient = {
            chat: async (_request, signal) => {
                cancelListener?.();
                observedAbortStates.push(signal.aborted);
                return {
                    message: {
                        role: "assistant",
                        content: "Cancelled request observed.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: () => { },
        };
        try {
            await runner.handleRequest({ prompt: "check cancellation" }, stream, cancellationToken);
            // Planning call + execution call.
            strict_1.default.deepEqual(observedAbortStates, [true, true]);
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Cancelled request observed."]);
        }
        finally {
            restoreConfig();
        }
    });
    test("executes tool calls and feeds tool results back to next model turn", async () => {
        const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 4 });
        const progress = [];
        const markdown = [];
        const executeCalls = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute(name, args) {
                executeCalls.push({ name, args });
                return { content: "file text" };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        const requests = [];
        let turn = 0;
        runner.llmClient = {
            chat: async (request) => {
                requests.push(request);
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                turn += 1;
                if (turn === 1) {
                    return {
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    function: {
                                        name: "read_file",
                                        arguments: { filePath: "/tmp/a" },
                                    },
                                },
                            ],
                        },
                    };
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Applied changes.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: (value) => progress.push(value),
        };
        try {
            await runner.handleRequest({ prompt: "read then answer" }, stream, createToken());
            strict_1.default.equal(executeCalls.length, 1);
            strict_1.default.deepEqual(executeCalls[0], {
                name: "read_file",
                args: { filePath: "/tmp/a" },
            });
            strict_1.default.ok(progress.some((line) => /Running tool read_file/i.test(line)));
            const executionRequests = requests.filter((call) => !isPlanningRequest(call));
            strict_1.default.equal(executionRequests.length, 2);
            const toolMessage = executionRequests[1].messages.find((message) => message.role === "tool" && message.tool_name === "read_file");
            strict_1.default.ok(toolMessage);
            strict_1.default.equal(toolMessage.content, JSON.stringify({ content: "file text" }));
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Applied changes."]);
        }
        finally {
            restoreConfig();
        }
    });
    test("executes multiple tool calls from one model turn", async () => {
        const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 4 });
        const progress = [];
        const markdown = [];
        const executed = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [
                    { name: "read_file", description: "Read", parameters: {} },
                    { name: "grep_search", description: "Search", parameters: {} },
                ];
            },
            async execute(name, args) {
                executed.push({ name, args });
                return { ok: true, name };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        let turn = 0;
        runner.llmClient = {
            chat: async (request) => {
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                turn += 1;
                if (turn === 1) {
                    return {
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    function: {
                                        name: "read_file",
                                        arguments: {
                                            filePath: "/tmp/a",
                                            startLine: 1,
                                            endLine: 50,
                                        },
                                    },
                                },
                                {
                                    function: {
                                        name: "grep_search",
                                        arguments: { query: "needle", isRegexp: false },
                                    },
                                },
                            ],
                        },
                    };
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Completed both tools.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: (value) => progress.push(value),
        };
        try {
            await runner.handleRequest({ prompt: "run two tools" }, stream, createToken());
            strict_1.default.equal(executed.length, 2);
            strict_1.default.deepEqual(executed.map((entry) => entry.name), ["read_file", "grep_search"]);
            strict_1.default.ok(progress.some((line) => /Running tool read_file/i.test(line)));
            strict_1.default.ok(progress.some((line) => /Running tool grep_search/i.test(line)));
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Completed both tools."]);
        }
        finally {
            restoreConfig();
        }
    });
    test("handles malformed tool arguments and tool execution failures deterministically", async () => {
        const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 3 });
        const markdown = [];
        const receivedArgs = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "write_file", description: "Write", parameters: {} }];
            },
            async execute(_name, args) {
                receivedArgs.push(args);
                throw new Error("write failed");
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        const requests = [];
        let turn = 0;
        runner.llmClient = {
            chat: async (request) => {
                requests.push(request);
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                turn += 1;
                if (turn === 1) {
                    return {
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    function: {
                                        name: "write_file",
                                        arguments: "{malformed-json",
                                    },
                                },
                            ],
                        },
                    };
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Recovered with explanation.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: () => { },
        };
        try {
            await runner.handleRequest({ prompt: "write file" }, stream, createToken());
            strict_1.default.deepEqual(receivedArgs, [{}]);
            const executionRequests = requests.filter((call) => !isPlanningRequest(call));
            strict_1.default.equal(executionRequests.length, 2);
            const toolMessage = executionRequests[1].messages.find((message) => message.role === "tool" && message.tool_name === "write_file");
            strict_1.default.ok(toolMessage);
            strict_1.default.equal(toolMessage.content, JSON.stringify({ error: "write failed" }));
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Recovered with explanation."]);
        }
        finally {
            restoreConfig();
        }
    });
    test("returns deterministic fallback when max agent steps end before final answer", async () => {
        const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 1 });
        const markdown = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute() {
                return { ok: true };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        runner.llmClient = {
            chat: async (request) => {
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                return {
                    message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [
                            {
                                function: {
                                    name: "read_file",
                                    arguments: { filePath: "/tmp/a" },
                                },
                            },
                        ],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: () => { },
        };
        try {
            await runner.handleRequest({ prompt: "do work" }, stream, createToken());
            strict_1.default.equal(markdown.length, 1);
            strict_1.default.match(markdown[0], /Agent stopped before producing a final answer/);
        }
        finally {
            restoreConfig();
        }
    });
    test("stops tool-only loop at configured max steps", async () => {
        const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 2 });
        const markdown = [];
        let executeCalls = 0;
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [{ name: "read_file", description: "Read", parameters: {} }];
            },
            async execute() {
                executeCalls += 1;
                return { ok: true };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        let chatCalls = 0;
        runner.llmClient = {
            chat: async (request) => {
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                chatCalls += 1;
                return {
                    message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [
                            {
                                function: {
                                    name: "read_file",
                                    arguments: { filePath: "/tmp/a", startLine: 1, endLine: 5 },
                                },
                            },
                        ],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: () => { },
        };
        try {
            await runner.handleRequest({ prompt: "keep going" }, stream, createToken());
            strict_1.default.equal(chatCalls, 2);
            strict_1.default.equal(executeCalls, 2);
            strict_1.default.equal(markdown.length, 1);
            strict_1.default.match(markdown[0], /Agent stopped before producing a final answer/);
        }
        finally {
            restoreConfig();
        }
    });
    test("executes simple 'start a new vite project' flow quickly in isolated test env", async () => {
        const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 4 });
        const markdown = [];
        const progress = [];
        const isolatedEnvPath = "/tmp/local-qwen-speed-flow-env";
        const forbiddenPath = "/Users/alexwaldmann/anthropic-copilot/testEnv";
        const executeCalls = [];
        const registry = {
            async refresh() { },
            getExecutableTools() {
                return [
                    {
                        name: "create_new_workspace",
                        description: "Scaffold a new project workspace.",
                        parameters: {},
                    },
                ];
            },
            async execute(name, args) {
                executeCalls.push({ name, args });
                return { workspacePath: isolatedEnvPath, ok: true };
            },
        };
        const output = { appendLine: () => { } };
        const runner = new localAgent_1.LocalAgentRunner(registry, output);
        let turn = 0;
        runner.llmClient = {
            chat: async (request) => {
                if (isPlanningRequest(request)) {
                    return planningOk();
                }
                turn += 1;
                if (turn === 1) {
                    return {
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: [
                                {
                                    function: {
                                        name: "create_new_workspace",
                                        arguments: {
                                            query: `start a new vite project in ${isolatedEnvPath}`,
                                        },
                                    },
                                },
                            ],
                        },
                    };
                }
                return {
                    message: {
                        role: "assistant",
                        content: "Created a new Vite project workspace.",
                        tool_calls: [],
                    },
                };
            },
        };
        const stream = {
            markdown: (value) => markdown.push(value),
            progress: (value) => progress.push(value),
        };
        const startedAt = Date.now();
        try {
            await runner.handleRequest({ prompt: "start a new vite project" }, stream, createToken());
            const elapsedMs = Date.now() - startedAt;
            strict_1.default.ok(elapsedMs < 1000, `expected fast flow, got ${elapsedMs}ms`);
            strict_1.default.equal(executeCalls.length, 1);
            strict_1.default.equal(executeCalls[0].name, "create_new_workspace");
            strict_1.default.equal(executeCalls[0].args.query, `start a new vite project in ${isolatedEnvPath}`);
            strict_1.default.ok(String(executeCalls[0].args.query).includes(isolatedEnvPath), "expected isolated temp test env path");
            strict_1.default.equal(String(executeCalls[0].args.query).includes(forbiddenPath), false);
            strict_1.default.ok(progress.some((line) => /Running tool create_new_workspace/i.test(line)));
            strict_1.default.deepEqual(markdown, ["[LOCAL QWEN] Created a new Vite project workspace."]);
        }
        finally {
            restoreConfig();
        }
    });
});
//# sourceMappingURL=localAgent.blackbox.test.js.map