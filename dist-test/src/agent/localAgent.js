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
exports.LocalAgentRunner = void 0;
const vscode = __importStar(require("vscode"));
const ollamaClient_1 = require("../llm/ollamaClient");
class LocalAgentRunner {
    toolRegistry;
    output;
    llmClient = new ollamaClient_1.OllamaClient();
    constructor(toolRegistry, output) {
        this.toolRegistry = toolRegistry;
        this.output = output;
    }
    async handleRequest(request, stream, token) {
        const configuration = vscode.workspace.getConfiguration('localQwen');
        const endpoint = configuration.get('endpoint', 'http://localhost:11434');
        const model = configuration.get('model', 'qwen2.5:32b');
        const maxAgentSteps = configuration.get('maxAgentSteps', 6);
        const temperature = configuration.get('temperature', 0.2);
        const abortController = new AbortController();
        if (token.isCancellationRequested) {
            abortController.abort();
        }
        else {
            token.onCancellationRequested(() => abortController.abort());
        }
        if (request.command === 'tools') {
            await this.toolRegistry.refresh();
            const discovered = this.toolRegistry.getExecutableTools();
            stream.markdown(this.renderTools(discovered.map((tool) => tool.name)));
            return;
        }
        await this.toolRegistry.refresh();
        const tools = this.toLlmTools(this.toolRegistry.getExecutableTools());
        const messages = [
            {
                role: 'system',
                content: [
                    'You are a local coding agent inside VS Code Chat.',
                    'Prefer calling tools when file or terminal access is needed.',
                    'When done, return a concise markdown answer.'
                ].join(' ')
            },
            {
                role: 'user',
                content: request.prompt
            }
        ];
        let finalAnswer = '';
        for (let step = 0; step < maxAgentSteps; step += 1) {
            const chatRequest = {
                endpoint,
                model,
                tools,
                messages,
                temperature
            };
            const result = await this.llmClient.chat(chatRequest, abortController.signal);
            const assistantMessage = result.message;
            messages.push(assistantMessage);
            const toolCalls = assistantMessage.tool_calls ?? [];
            if (toolCalls.length === 0) {
                finalAnswer = assistantMessage.content ?? '';
                break;
            }
            for (const toolCall of toolCalls) {
                const toolName = toolCall.function.name;
                const toolArgs = this.parseToolArgs(toolCall);
                stream.progress(`Running tool ${toolName}...`);
                this.output.appendLine(`[local-qwen] tool call: ${toolName}(${JSON.stringify(toolArgs)})`);
                try {
                    const toolResult = await this.toolRegistry.execute(toolName, toolArgs);
                    messages.push({
                        role: 'tool',
                        tool_name: toolName,
                        content: JSON.stringify(toolResult)
                    });
                }
                catch (error) {
                    const errorText = error instanceof Error ? error.message : String(error);
                    messages.push({
                        role: 'tool',
                        tool_name: toolName,
                        content: JSON.stringify({ error: errorText })
                    });
                }
            }
        }
        if (!finalAnswer) {
            finalAnswer = 'Agent stopped before producing a final answer. Try increasing `localQwen.maxAgentSteps`.';
        }
        stream.markdown(finalAnswer);
    }
    parseToolArgs(toolCall) {
        const raw = toolCall.function.arguments;
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return parsed;
            }
            catch {
                return {};
            }
        }
        return raw ?? {};
    }
    toLlmTools(tools) {
        return tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }));
    }
    renderTools(toolNames) {
        if (toolNames.length === 0) {
            return 'No executable tools discovered yet. Configure `localQwen.toolDiscoveryRoots` and run refresh.';
        }
        return `Discovered tools:\n\n${toolNames.map((name) => `- ${name}`).join('\n')}`;
    }
}
exports.LocalAgentRunner = LocalAgentRunner;
//# sourceMappingURL=localAgent.js.map