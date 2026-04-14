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
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const OLLAMA_VERSION_URL = 'http://127.0.0.1:11434/api/version';
const OLLAMA_REQUEST_TIMEOUT_MS = 240_000;
const OLLAMA_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;
const OLLAMA_PREFLIGHT_TIMEOUT_MS = 3_000;
const OLLAMA_CLI_TIMEOUT_MS = 3_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CONTENT_CHARS = 12_000;
const MAX_AUTO_TOOLS = 8;
const CLI_ACCESS_OLLAMA = true;
const OLLAMA_TARGET_CHAT_SESSION_TYPE = process.env.OLLAMA_TARGET_CHAT_SESSION_TYPE || 'copilotcli';
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
class OllamaProvider {
    async provideLanguageModelChatInformation(_options, token) {
        const modelIds = await this.fetchAvailableModelIds(token);
        const discoveredIds = modelIds.length > 0 ? modelIds : ['gemma4:e4b'];
        return discoveredIds.map((id) => ({
            id,
            name: id,
            family: 'local-ollama',
            version: '1.0.0',
            maxInputTokens: 131072,
            maxOutputTokens: 8192,
            detail: modelIds.length > 0 ? 'Local Ollama model' : 'Local Ollama model (fallback)',
            tooltip: 'Runs locally through Ollama',
            multiplier: '0x',
            multiplierNumeric: 0,
            isUserSelectable: true,
            targetChatSessionType: OLLAMA_TARGET_CHAT_SESSION_TYPE,
            capabilities: {
                imageInput: false,
                toolCalling: true
            }
        }));
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => {
            abortController.abort();
        });
        try {
            await this.ensureOllamaAvailable(abortController.signal);
            const baseHistory = this.toOllamaMessages(messages);
            const forwardedInstructions = this.extractCopilotInstructions(options.modelOptions);
            const historyWithInstructions = this.withForwardedInstructions(baseHistory, forwardedInstructions);
            const history = this.pruneHistory(historyWithInstructions);
            if (history.length === 0) {
                return;
            }
            const ollamaTools = this.toOllamaTools(options.tools ?? []);
            const requiresTool = options.toolMode === vscode.LanguageModelChatToolMode.Required;
            const modelHasRequested = Boolean(options.modelOptions?.modelHasRequested);
            const effectiveTools = this.selectToolsForRequest(messages, ollamaTools, requiresTool || modelHasRequested);
            if (requiresTool && effectiveTools.length === 0) {
                throw new Error('Tool mode is Required but no tools were provided.');
            }
            console.log('[ollama] request start', {
                model: model.id,
                requestInitiator: options.requestInitiator,
                targetChatSessionType: OLLAMA_TARGET_CHAT_SESSION_TYPE,
                messageCount: history.length,
                toolCount: effectiveTools.length,
                modelHasRequested,
                forwardedInstructionCount: forwardedInstructions.length,
                toolMode: options.toolMode,
                inputSummary: this.summarizeInput(messages)
            });
            await this.requestResponse(model.id, history, effectiveTools.length > 0 ? effectiveTools : undefined, progress, abortController.signal);
            console.log('[ollama] request end');
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
    async fetchAvailableModelIds(parentToken) {
        const parentAbortController = new AbortController();
        const tokenDisposable = parentToken.onCancellationRequested(() => {
            parentAbortController.abort();
        });
        const fetchAbort = this.createTimeoutAbortController(parentAbortController.signal, OLLAMA_MODEL_DISCOVERY_TIMEOUT_MS, 'Ollama model discovery timeout');
        try {
            const response = await fetch(OLLAMA_TAGS_URL, {
                method: 'GET',
                signal: fetchAbort.signal
            });
            if (!response.ok) {
                return [];
            }
            const json = (await response.json());
            return [...new Set((json.models ?? [])
                    .map((model) => model.name)
                    .filter((name) => typeof name === 'string' && name.length > 0))];
        }
        catch {
            return [];
        }
        finally {
            fetchAbort.dispose();
            tokenDisposable.dispose();
        }
    }
    async ensureOllamaAvailable(signal) {
        const preflightAbort = this.createTimeoutAbortController(signal, OLLAMA_PREFLIGHT_TIMEOUT_MS, 'Ollama preflight timeout');
        try {
            const response = await fetch(OLLAMA_VERSION_URL, {
                method: 'GET',
                signal: preflightAbort.signal
            });
            if (!response.ok) {
                throw new Error(`Ollama preflight failed: ${response.status} ${response.statusText}`);
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!CLI_ACCESS_OLLAMA) {
                throw new Error(`Ollama is not reachable at 127.0.0.1:11434 (${message})`);
            }
            const cliProbe = await this.probeOllamaCli(signal);
            const cliHint = cliProbe.ok
                ? `CLI access enabled and responding (${cliProbe.detail})`
                : `CLI access enabled but probe failed (${cliProbe.detail})`;
            throw new Error(`Ollama is not reachable at 127.0.0.1:11434 (${message}). ${cliHint}`);
        }
        finally {
            preflightAbort.dispose();
        }
    }
    async probeOllamaCli(signal) {
        if (signal.aborted) {
            return { ok: false, detail: 'cancelled' };
        }
        try {
            const { stdout, stderr } = await execFileAsync('ollama', ['ps'], {
                timeout: OLLAMA_CLI_TIMEOUT_MS,
                maxBuffer: 128 * 1024
            });
            const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
            return {
                ok: true,
                detail: output.length > 0 ? output.split('\n')[0] : 'ollama ps succeeded'
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, detail: message };
        }
    }
    async requestResponse(modelId, history, tools, progress, signal) {
        const startedAt = Date.now();
        const fetchAbort = this.createTimeoutAbortController(signal, OLLAMA_REQUEST_TIMEOUT_MS, 'Ollama request timeout');
        let res;
        const payload = {
            model: modelId,
            messages: history,
            tools,
            stream: false,
            think: false,
            keep_alive: '30m'
        };
        const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        try {
            res = await fetch(OLLAMA_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: fetchAbort.signal
            });
            console.log('[ollama] request completed', {
                elapsedMs: Date.now() - startedAt,
                toolCount: tools?.length ?? 0,
                payloadBytes
            });
        }
        finally {
            fetchAbort.dispose();
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Ollama request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
        }
        if (!res.body) {
            throw new Error('Ollama returned no response body.');
        }
        const json = (await res.json());
        const content = json.message?.content;
        if (typeof content === 'string' && content.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(content));
        }
        const toolCalls = json.message?.tool_calls ?? [];
        toolCalls.forEach((toolCall, index) => {
            const functionName = toolCall.function?.name;
            if (!functionName) {
                return;
            }
            progress.report(new vscode.LanguageModelToolCallPart(this.createToolCallId(functionName, index), functionName, this.normalizeToolArguments(toolCall.function?.arguments)));
        });
        console.log('[ollama] response parts emitted', {
            elapsedMs: Date.now() - startedAt,
            contentChars: typeof content === 'string' ? content.length : 0,
            toolCallCount: toolCalls.length,
            hasThinking: typeof json.message?.thinking === 'string' && json.message.thinking.length > 0
        });
    }
    summarizeInput(messages) {
        let userTextChars = 0;
        let assistantTextChars = 0;
        let toolCallParts = 0;
        let toolResultParts = 0;
        for (const msg of messages) {
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                        userTextChars += part.value.length;
                    }
                    else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
                        assistantTextChars += part.value.length;
                    }
                }
                else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallParts += 1;
                }
                else if (part instanceof vscode.LanguageModelToolResultPart) {
                    toolResultParts += 1;
                }
            }
        }
        return {
            messageCount: messages.length,
            userTextChars,
            assistantTextChars,
            toolCallParts,
            toolResultParts
        };
    }
    selectToolsForRequest(messages, tools, requireFullTools) {
        if (requireFullTools) {
            return tools;
        }
        const latestUserText = this.getLatestUserText(messages).trim().toLowerCase();
        const isSimpleGreeting = /^(hi|hello|hey|yo|sup|hola|bonjour|howdy)[!.?\s]*$/.test(latestUserText);
        if (isSimpleGreeting) {
            return [];
        }
        return tools.slice(0, MAX_AUTO_TOOLS);
    }
    extractCopilotInstructions(modelOptions) {
        if (!modelOptions) {
            return [];
        }
        const candidates = [
            modelOptions.vscodeCopilotInstructions,
            modelOptions.instructions,
            modelOptions.systemPrompt,
            modelOptions.promptInstructions
        ];
        const instructionLines = [];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
                instructionLines.push(candidate.trim());
                continue;
            }
            if (Array.isArray(candidate)) {
                for (const item of candidate) {
                    if (typeof item === 'string' && item.trim().length > 0) {
                        instructionLines.push(item.trim());
                    }
                }
            }
        }
        return [...new Set(instructionLines)];
    }
    withForwardedInstructions(history, instructions) {
        if (instructions.length === 0) {
            return history;
        }
        const content = instructions.join('\n\n');
        return [
            {
                role: 'system',
                content
            },
            ...history
        ];
    }
    getLatestUserText(messages) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const msg = messages[i];
            if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                return this.flattenMessageContent(msg);
            }
        }
        return '';
    }
    pruneHistory(history) {
        if (history.length <= MAX_HISTORY_MESSAGES) {
            const charCount = history.reduce((sum, m) => sum + m.content.length, 0);
            if (charCount <= MAX_HISTORY_CONTENT_CHARS) {
                return history;
            }
        }
        const latestUserIndex = this.findLatestUserIndex(history);
        const groups = this.buildHistoryGroups(history);
        const pinnedGroupIndexes = new Set();
        const latestUserGroupIndex = this.findGroupIndexContaining(groups, latestUserIndex);
        const latestGroupIndex = groups.length - 1;
        if (latestUserGroupIndex >= 0) {
            pinnedGroupIndexes.add(latestUserGroupIndex);
        }
        if (latestGroupIndex >= 0) {
            pinnedGroupIndexes.add(latestGroupIndex);
        }
        const selectedGroups = new Set();
        let selectedMessageCount = 0;
        let selectedChars = 0;
        for (let g = groups.length - 1; g >= 0; g -= 1) {
            const group = groups[g];
            const wouldExceedCount = selectedMessageCount + group.length > MAX_HISTORY_MESSAGES;
            const wouldExceedChars = selectedChars + this.groupCharCount(group, history) > MAX_HISTORY_CONTENT_CHARS;
            if ((wouldExceedCount || wouldExceedChars) && selectedMessageCount > 0) {
                continue;
            }
            selectedGroups.add(g);
            selectedMessageCount += group.length;
            selectedChars += this.groupCharCount(group, history);
        }
        for (const pinnedGroupIndex of pinnedGroupIndexes) {
            if (!selectedGroups.has(pinnedGroupIndex)) {
                selectedGroups.add(pinnedGroupIndex);
                selectedMessageCount += groups[pinnedGroupIndex].length;
                selectedChars += this.groupCharCount(groups[pinnedGroupIndex], history);
            }
        }
        const removableGroups = () => [...selectedGroups]
            .sort((a, b) => a - b)
            .filter((groupIndex) => !pinnedGroupIndexes.has(groupIndex));
        while (selectedMessageCount > MAX_HISTORY_MESSAGES) {
            const [candidate] = removableGroups();
            if (candidate === undefined) {
                break;
            }
            selectedGroups.delete(candidate);
            selectedMessageCount -= groups[candidate].length;
            selectedChars -= this.groupCharCount(groups[candidate], history);
        }
        while (selectedChars > MAX_HISTORY_CONTENT_CHARS && selectedGroups.size > pinnedGroupIndexes.size) {
            const [candidate] = removableGroups();
            if (candidate === undefined) {
                break;
            }
            selectedGroups.delete(candidate);
            selectedMessageCount -= groups[candidate].length;
            selectedChars -= this.groupCharCount(groups[candidate], history);
        }
        return [...selectedGroups]
            .sort((a, b) => a - b)
            .flatMap((groupIndex) => groups[groupIndex])
            .map((idx) => history[idx]);
    }
    buildHistoryGroups(history) {
        const groups = [];
        for (let i = 0; i < history.length;) {
            const message = history[i];
            if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) {
                const group = [i];
                let j = i + 1;
                while (j < history.length && history[j].role === 'tool') {
                    group.push(j);
                    j += 1;
                }
                groups.push(group);
                i = j;
                continue;
            }
            if (message.role === 'tool') {
                const group = [i];
                let j = i + 1;
                while (j < history.length && history[j].role === 'tool') {
                    group.push(j);
                    j += 1;
                }
                groups.push(group);
                i = j;
                continue;
            }
            groups.push([i]);
            i += 1;
        }
        return groups;
    }
    findGroupIndexContaining(groups, messageIndex) {
        if (messageIndex < 0) {
            return -1;
        }
        for (let i = 0; i < groups.length; i += 1) {
            if (groups[i].includes(messageIndex)) {
                return i;
            }
        }
        return -1;
    }
    groupCharCount(group, history) {
        return group.reduce((sum, index) => sum + history[index].content.length, 0);
    }
    findLatestUserIndex(history) {
        for (let i = history.length - 1; i >= 0; i -= 1) {
            if (history[i].role === 'user' && history[i].content.trim().length > 0) {
                return i;
            }
        }
        return -1;
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
    normalizeToolArguments(args) {
        if (!args) {
            return {};
        }
        if (typeof args === 'string') {
            try {
                const parsed = JSON.parse(args);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            }
            catch {
                return {};
            }
            return {};
        }
        if (typeof args === 'object' && !Array.isArray(args)) {
            return args;
        }
        return {};
    }
    createToolCallId(functionName, index) {
        return `${functionName}-${Date.now()}-${index}`;
    }
    createTimeoutAbortController(parentSignal, timeoutMs, reason) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort(new Error(reason));
        }, timeoutMs);
        const onParentAbort = () => {
            controller.abort(parentSignal.reason);
        };
        parentSignal.addEventListener('abort', onParentAbort);
        return {
            signal: controller.signal,
            dispose: () => {
                clearTimeout(timeoutId);
                parentSignal.removeEventListener('abort', onParentAbort);
            }
        };
    }
    async readWithTimeout(reader, timeoutMs, signal) {
        if (signal.aborted) {
            throw new Error('Ollama request was cancelled.');
        }
        return await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`Ollama stream stalled for ${timeoutMs}ms.`));
            }, timeoutMs);
            const onAbort = () => {
                clearTimeout(timeoutId);
                reject(new Error('Ollama request was cancelled.'));
            };
            signal.addEventListener('abort', onAbort);
            reader
                .read()
                .then((result) => {
                clearTimeout(timeoutId);
                signal.removeEventListener('abort', onAbort);
                resolve(result);
            })
                .catch((err) => {
                clearTimeout(timeoutId);
                signal.removeEventListener('abort', onAbort);
                reject(err);
            });
        });
    }
    toOllamaMessages(messages) {
        const result = [];
        const callIdToToolName = new Map();
        for (const msg of messages) {
            const role = this.toOllamaRole(msg.role);
            const text = this.flattenMessageContent(msg);
            const toolCalls = [];
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    callIdToToolName.set(part.callId, part.name);
                    toolCalls.push({
                        function: {
                            name: part.name,
                            arguments: part.input
                        }
                    });
                    continue;
                }
                if (part instanceof vscode.LanguageModelToolResultPart) {
                    const toolName = callIdToToolName.get(part.callId) ?? 'tool';
                    result.push({
                        role: 'tool',
                        name: toolName,
                        content: this.stringifyUnknownParts(part.content ?? [])
                    });
                }
            }
            if (text.length > 0 || toolCalls.length > 0) {
                result.push({
                    role,
                    content: text,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                });
            }
        }
        return result;
    }
    flattenMessageContent(msg) {
        return msg.content
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value)
            .join('');
    }
    stringifyUnknownParts(parts) {
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
//# sourceMappingURL=extension.js.map