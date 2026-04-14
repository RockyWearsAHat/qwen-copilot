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
const ollamaClient_1 = require("../../src/llm/ollamaClient");
function normalizeArgs(args) {
    if (typeof args === "string") {
        try {
            const parsed = JSON.parse(args);
            return parsed && typeof parsed === "object" ? parsed : {};
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
async function singleTurn(client, endpoint, model, prompt, tools) {
    const result = await client.chat({
        endpoint,
        model,
        temperature: 0,
        tools,
        messages: [
            {
                role: "system",
                content: "Return exactly one tool call for the user request. Do not emit extra tool calls or unrelated commands.",
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        maxOutputTokens: 512,
        contextWindowTokens: 16384,
    }, new AbortController().signal, 0);
    return {
        content: result.message.content ?? "",
        toolCalls: result.message.tool_calls ?? [],
    };
}
suite("E2E simple one-step behaviors (opt-in)", function () {
    this.timeout(180000);
    const runE2E = process.env.LOCAL_QWEN_E2E_SIMPLE === "1";
    const endpoint = process.env.LOCAL_QWEN_E2E_ENDPOINT ?? "http://localhost:11434";
    const model = process.env.LOCAL_QWEN_E2E_MODEL ?? "qwen3-coder:30b-256k";
    const client = new ollamaClient_1.OllamaClient();
    let blankWorkspace = "";
    const tools = [
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
    setup(async () => {
        blankWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-simple-behaviors-"));
    });
    (runE2E ? test : test.skip)("when asked to start a vite project, it emits exactly one valid scaffold call", async () => {
        const { toolCalls } = await singleTurn(client, endpoint, model, `In blank workspace '${blankWorkspace}', start a vite project. Use exactly one tool call only.`, tools);
        strict_1.default.equal(toolCalls.length, 1, `expected exactly one tool call, got ${toolCalls.length}`);
        const call = toolCalls[0];
        const args = normalizeArgs(call.function.arguments);
        if (call.function.name === "create_new_workspace") {
            const query = String(args.query ?? "");
            strict_1.default.ok(query.toLowerCase().includes("vite"), `expected vite in workspace query: ${query}`);
            strict_1.default.ok(query.includes(blankWorkspace), `expected blank workspace path in query: ${query}`);
            return;
        }
        strict_1.default.equal(call.function.name, "run_in_terminal", `expected create_new_workspace or run_in_terminal, got ${call.function.name}`);
        const command = String(args.command ?? "");
        strict_1.default.ok(/vite|npm\s+create\s+vite|pnpm\s+create\s+vite|yarn\s+create\s+vite/i.test(command), `expected vite scaffold command, got: ${command}`);
        strict_1.default.equal(/&&|\|\||;|\n/.test(command), false, `expected one-step terminal command without chaining, got: ${command}`);
        strict_1.default.equal(/rm\s+-rf|curl\s+|wget\s+|sudo\s+/i.test(command), false, `unexpected extra/destructive terminal action in command: ${command}`);
    });
    (runE2E ? test : test.skip)("when asked to create index.html with content, it emits exactly one create_file call", async () => {
        const htmlMarker = "<h1>Simple E2E Marker</h1>";
        const { toolCalls } = await singleTurn(client, endpoint, model, [
            `In blank workspace '${blankWorkspace}', create index.html with this exact marker: ${htmlMarker}.`,
            "Use exactly one tool call only.",
        ].join(" "), tools);
        strict_1.default.equal(toolCalls.length, 1, `expected exactly one tool call, got ${toolCalls.length}`);
        strict_1.default.equal(toolCalls[0].function.name, "create_file");
        const args = normalizeArgs(toolCalls[0].function.arguments);
        const filePath = String(args.filePath ?? "");
        const content = String(args.content ?? "");
        strict_1.default.ok(filePath.endsWith("index.html"), `expected index.html path, got: ${filePath}`);
        strict_1.default.ok(filePath.includes(blankWorkspace) || filePath === "index.html", `expected filePath to target blank workspace or be relative index.html, got: ${filePath}`);
        strict_1.default.ok(content.trim().length > 0, "expected non-empty html content");
        strict_1.default.ok(content.includes("Simple E2E Marker"), `expected marker in content: ${content}`);
    });
    (runE2E ? test : test.skip)("when asked to run a python snippet, it emits exactly one pylance snippet execution call and no terminal command", async () => {
        const { toolCalls } = await singleTurn(client, endpoint, model, [
            `In blank workspace '${blankWorkspace}', run this python snippet: print(2 + 2).`,
            "Use exactly one tool call only and do not use terminal commands.",
        ].join(" "), tools);
        strict_1.default.equal(toolCalls.length, 1, `expected exactly one tool call, got ${toolCalls.length}`);
        strict_1.default.equal(toolCalls[0].function.name, "mcp_pylance_mcp_s_pylanceRunCodeSnippet");
        const args = normalizeArgs(toolCalls[0].function.arguments);
        const workspaceRoot = String(args.workspaceRoot ?? "");
        const codeSnippet = String(args.codeSnippet ?? "");
        strict_1.default.equal(toolCalls.some((toolCall) => toolCall.function.name === "run_in_terminal"), false, "python snippet task should not use run_in_terminal");
        strict_1.default.ok(workspaceRoot.includes(blankWorkspace), `expected workspaceRoot to target blank workspace, got: ${workspaceRoot}`);
        strict_1.default.ok(codeSnippet.includes("print(2 + 2)") ||
            codeSnippet.includes("print(2+2)"));
    });
});
//# sourceMappingURL=e2eSimpleBehaviors.test.js.map