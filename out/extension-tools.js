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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MAX_TOOL_ROUNDS = 4;
class OllamaProvider {
    provideLanguageModelChatInformation(_options, _token) {
        return [
            {
                id: 'gemma4:e2b',
                name: 'gemma4:e2b',
                family: 'local-ollama',
                version: '1.0.0',
                maxInputTokens: 131072,
                maxOutputTokens: 8192,
                detail: 'Local Ollama model',
                tooltip: 'Runs locally through Ollama',
                multiplier: '0x',
                multiplierNumeric: 0,
                isUserSelectable: true,
                capabilities: {
                    imageInput: false,
                    toolCalling: true
                }
            }
        ];
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => {
            abortController.abort();
        });
        try {
            const history = this.toOllamaMessages(messages);
            if (history.length === 0) {
                return;
            }
            const vscodeTools = options.tools ?? [];
            const ollamaTools = this.toOllamaTools(vscodeTools);
            console.log('[ollama] request start', {
                model: model.id,
                messageCount: history.length,
                toolCount: vscodeTools.length
            });
            if (ollamaTools.length === 0) {
                await this.streamChat(model.id, history, progress, abortController.signal);
                console.log('[ollama] request end (stream, no tools)');
                return;
            }
            await this.runToolLoop(model.id, history, vscodeTools, ollamaTools, progress, abortController.signal);
            console.log('[ollama] request end (tool loop)');
        }
        catch (err) {
            if (token.isCancellationRequested || abortController.signal.aborted) {
                throw new Error('Ollama request was cancelled.');
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error('[ollama] provider error', err);
            throw new Error(`Ollama provider failed: ${message}`);
        }
        finally {
            cancelDisposable.dispose();
        }
    }
    async provideTokenCount(_model, text, _token) {
        const raw = typeof text === 'string' ? text : this.flattenMessageContent(text);
        return Math.ceil(raw.length / 4);
    }
    async streamChat(modelId, history, progress, signal) {
        const res = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelId,
                messages: history,
                stream: true
            }),
            signal
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Ollama request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
        }
        if (!res.body) {
            throw new Error('Ollama returned no response body.');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let emittedText = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        continue;
                    }
                    let json;
                    try {
                        json = JSON.parse(trimmed);
                    }
                    catch {
                        continue;
                    }
                    const chunk = json.message?.content;
                    if (typeof chunk === 'string' && chunk.length > 0) {
                        emittedText = true;
                        progress.report(new vscode.LanguageModelTextPart(chunk));
                    }
                    if (json.done === true) {
                        return;
                    }
                }
            }
            const flushed = decoder.decode();
            if (flushed) {
                buffer += flushed;
            }
            const tail = buffer.trim();
            if (tail) {
                try {
                    const json = JSON.parse(tail);
                    const chunk = json.message?.content;
                    if (typeof chunk === 'string' && chunk.length > 0) {
                        emittedText = true;
                        progress.report(new vscode.LanguageModelTextPart(chunk));
                    }
                }
                catch {
                    // ignore trailing malformed buffer
                }
            }
            if (!emittedText) {
                console.warn('[ollama] stream ended without text');
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    async runToolLoop(modelId, history, vscodeTools, ollamaTools, progress, signal) {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const res = await fetch(OLLAMA_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: history,
                    tools: ollamaTools,
                    stream: false
                }),
                signal
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`Ollama request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
            }
            const json = (await res.json());
            const assistantContent = json.message?.content ?? '';
            const toolCalls = json.message?.tool_calls ?? [];
            history.push({
                role: 'assistant',
                content: assistantContent,
                tool_calls: toolCalls
            });
            if (toolCalls.length === 0) {
                if (assistantContent) {
                    progress.report(new vscode.LanguageModelTextPart(assistantContent));
                }
                return;
            }
            for (const toolCall of toolCalls) {
                const functionName = toolCall.function?.name;
                const args = toolCall.function?.arguments ?? {};
                if (!functionName) {
                    continue;
                }
                const matchedTool = vscodeTools.find((tool) => tool.name === functionName);
                const toolCallId = `${functionName}-${round}-${Math.random().toString(36).slice(2, 10)}`;
                progress.report(new vscode.LanguageModelToolCallPart(toolCallId, functionName, args));
                if (!matchedTool) {
                    const errorText = JSON.stringify({ error: `Tool not found: ${functionName}` });
                    progress.report(new vscode.LanguageModelToolResultPart(toolCallId, [
                        new vscode.LanguageModelTextPart(errorText)
                    ]));
                    history.push({
                        role: 'tool',
                        name: functionName,
                        content: errorText
                    });
                    continue;
                }
                try {
                    const result = await vscode.lm.invokeTool(matchedTool.name, {
                        input: args,
                        toolInvocationToken: undefined
                    });
                    const resultText = this.stringifyToolResult(result);
                    progress.report(new vscode.LanguageModelToolResultPart(toolCallId, [
                        new vscode.LanguageModelTextPart(resultText)
                    ]));
                    history.push({
                        role: 'tool',
                        name: functionName,
                        content: resultText
                    });
                }
                catch (err) {
                    const errorText = JSON.stringify({
                        error: err instanceof Error ? err.message : String(err)
                    });
                    progress.report(new vscode.LanguageModelToolResultPart(toolCallId, [
                        new vscode.LanguageModelTextPart(errorText)
                    ]));
                    history.push({
                        role: 'tool',
                        name: functionName,
                        content: errorText
                    });
                }
            }
        }
        throw new Error(`Exceeded maximum tool rounds (${MAX_TOOL_ROUNDS}).`);
    }
    toOllamaTools(tools) {
        return tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: this.normalizeToolInputSchema(tool.inputSchema)
            }
        }));
    }
    normalizeToolInputSchema(schema) {
        if (!schema || typeof schema !== 'object') {
            return undefined;
        }
        return schema;
    }
    toOllamaMessages(messages) {
        return messages
            .map((msg) => ({
            role: this.toOllamaRole(msg.role),
            content: this.flattenMessageContent(msg)
        }))
            .filter((msg) => msg.content.length > 0);
    }
    flattenMessageContent(msg) {
        return msg.content
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value)
            .join('');
    }
    stringifyToolResult(result) {
        const parts = result.content ?? [];
        return parts
            .map((part) => {
            if (part instanceof vscode.LanguageModelTextPart) {
                return part.value;
            }
            try {
                return JSON.stringify(part);
            }
            catch {
                return String(part);
            }
        })
            .join('\n');
    }
    toOllamaRole(role) {
        switch (role) {
            case vscode.LanguageModelChatMessageRole.Assistant:
                return 'assistant';
            case vscode.LanguageModelChatMessageRole.User:
                return 'user';
            default:
                return 'system';
        }
    }
}
function activate(context) {
    const disposable = vscode.lm.registerLanguageModelChatProvider('local', new OllamaProvider());
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension-tools.js.map