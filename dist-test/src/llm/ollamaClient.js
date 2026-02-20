"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaClient = void 0;
class OllamaClient {
    async getModelContextLength(endpoint, modelName, abortSignal, timeoutMs) {
        const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);
        let response;
        try {
            response = await fetch(`${endpoint.replace(/\/$/, "")}/api/show`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: modelName,
                }),
                signal: timeoutState.signal,
            });
        }
        catch (error) {
            if (timeoutState.didTimeout()) {
                throw new Error(`Ollama model show timed out after ${timeoutState.timeoutMs}ms for '${modelName}'.`);
            }
            throw error;
        }
        finally {
            timeoutState.dispose();
        }
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Ollama model show failed (${response.status}): ${text}`);
        }
        const payload = (await response.json());
        const modelInfo = payload.model_info ?? {};
        const direct = this.toPositiveInteger(modelInfo.context_length);
        if (direct) {
            return direct;
        }
        for (const [key, value] of Object.entries(modelInfo)) {
            if (!key.endsWith(".context_length")) {
                continue;
            }
            const parsed = this.toPositiveInteger(value);
            if (parsed) {
                return parsed;
            }
        }
        return undefined;
    }
    async chat(request, abortSignal, timeoutMs) {
        const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);
        let response;
        try {
            response = await fetch(`${request.endpoint.replace(/\/$/, "")}/api/chat`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: request.model,
                    stream: false,
                    messages: request.messages,
                    tools: request.tools,
                    options: {
                        temperature: request.temperature,
                        ...(typeof request.maxOutputTokens === "number" &&
                            request.maxOutputTokens > 0
                            ? { num_predict: request.maxOutputTokens }
                            : {}),
                        ...(typeof request.contextWindowTokens === "number" &&
                            request.contextWindowTokens > 0
                            ? { num_ctx: request.contextWindowTokens }
                            : {}),
                    },
                }),
                signal: timeoutState.signal,
            });
        }
        catch (error) {
            if (timeoutState.didTimeout()) {
                throw new Error(`Ollama chat request timed out after ${timeoutState.timeoutMs}ms.`);
            }
            throw new Error(`Ollama chat request transport failed for model '${request.model}' at '${request.endpoint}': ${this.describeTransportError(error)}`);
        }
        finally {
            timeoutState.dispose();
        }
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Ollama request failed (${response.status}): ${text}`);
        }
        const payload = (await response.json());
        if (!payload.message) {
            throw new Error("Ollama response did not include a message payload.");
        }
        return { message: payload.message };
    }
    /**
     * Streaming version of chat.  Returns an async iterable of partial response
     * chunks so that the caller can report incremental text to Copilot as it
     * arrives — critical for not hitting the request timeout on large prompts.
     *
     * Ollama's streaming format sends one JSON object per line, each with a
     * `message.content` delta, and the final chunk has `done: true` plus a
     * full aggregated `message` with `tool_calls` if any.
     */
    async chatStream(request, abortSignal, timeoutMs) {
        const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);
        let response;
        try {
            response = await fetch(`${request.endpoint.replace(/\/$/, "")}/api/chat`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: request.model,
                    stream: true,
                    messages: request.messages,
                    tools: request.tools,
                    options: {
                        temperature: request.temperature,
                        ...(typeof request.maxOutputTokens === "number" &&
                            request.maxOutputTokens > 0
                            ? { num_predict: request.maxOutputTokens }
                            : {}),
                        ...(typeof request.contextWindowTokens === "number" &&
                            request.contextWindowTokens > 0
                            ? { num_ctx: request.contextWindowTokens }
                            : {}),
                    },
                }),
                signal: timeoutState.signal,
            });
        }
        catch (error) {
            timeoutState.dispose();
            if (timeoutState.didTimeout()) {
                throw new Error(`Ollama chat request timed out after ${timeoutState.timeoutMs}ms.`);
            }
            throw new Error(`Ollama streaming chat transport failed for model '${request.model}' at '${request.endpoint}': ${this.describeTransportError(error)}`);
        }
        if (!response.ok) {
            timeoutState.dispose();
            const text = await response.text();
            throw new Error(`Ollama request failed (${response.status}): ${text}`);
        }
        if (!response.body) {
            timeoutState.dispose();
            throw new Error("Ollama response body is null — streaming unavailable.");
        }
        return {
            stream: this.parseStreamBody(response.body, timeoutState),
        };
    }
    async *parseStreamBody(body, timeoutState) {
        const decoder = new TextDecoder();
        const reader = body.getReader();
        let buffer = "";
        try {
            while (true) {
                let readResult;
                try {
                    readResult = await reader.read();
                }
                catch (error) {
                    if (timeoutState.didTimeout()) {
                        throw new Error(`Ollama chat request timed out after ${timeoutState.timeoutMs}ms.`);
                    }
                    throw error;
                }
                const { done, value } = readResult;
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    // Data arrived — reset idle timer so slow-but-active streams
                    // are not killed.  The timeout now only fires if Ollama goes
                    // completely silent for the full timeout period.
                    timeoutState.resetIdleTimer();
                }
                // Parse complete lines from the buffer.
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) {
                        continue;
                    }
                    let chunk;
                    try {
                        chunk = JSON.parse(trimmed);
                    }
                    catch {
                        continue; // malformed JSON line — skip
                    }
                    if (chunk.message) {
                        yield {
                            done: chunk.done ?? false,
                            message: chunk.message,
                        };
                    }
                }
                if (done) {
                    break;
                }
            }
        }
        finally {
            reader.releaseLock();
            timeoutState.dispose();
        }
    }
    async listModels(endpoint, abortSignal, timeoutMs) {
        const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);
        let response;
        try {
            response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
                signal: timeoutState.signal,
            });
        }
        catch (error) {
            if (timeoutState.didTimeout()) {
                throw new Error(`Ollama model listing timed out after ${timeoutState.timeoutMs}ms.`);
            }
            throw error;
        }
        finally {
            timeoutState.dispose();
        }
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Ollama model listing failed (${response.status}): ${text}`);
        }
        const payload = (await response.json());
        return payload.models ?? [];
    }
    createTimeoutState(abortSignal, timeoutMs) {
        const effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
        if (effectiveTimeoutMs <= 0) {
            return {
                signal: abortSignal,
                timeoutMs: 0,
                didTimeout: () => false,
                resetIdleTimer: () => { },
                dispose: () => { },
            };
        }
        const timeoutController = new AbortController();
        const mergedController = new AbortController();
        let didTimeout = false;
        const forwardAbort = () => {
            if (!mergedController.signal.aborted) {
                mergedController.abort();
            }
        };
        const onParentAbort = () => forwardAbort();
        const onTimeoutAbort = () => forwardAbort();
        if (abortSignal.aborted) {
            onParentAbort();
        }
        else {
            abortSignal.addEventListener("abort", onParentAbort, { once: true });
        }
        timeoutController.signal.addEventListener("abort", onTimeoutAbort, {
            once: true,
        });
        let timer = setTimeout(() => {
            didTimeout = true;
            timeoutController.abort();
        }, effectiveTimeoutMs);
        const resetIdleTimer = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                didTimeout = true;
                timeoutController.abort();
            }, effectiveTimeoutMs);
        };
        return {
            signal: mergedController.signal,
            timeoutMs: effectiveTimeoutMs,
            didTimeout: () => didTimeout,
            resetIdleTimer,
            dispose: () => {
                clearTimeout(timer);
                abortSignal.removeEventListener("abort", onParentAbort);
                timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
            },
        };
    }
    toPositiveInteger(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            const normalized = Math.floor(value);
            return normalized > 0 ? normalized : undefined;
        }
        if (typeof value === "string") {
            const normalized = Number.parseInt(value, 10);
            return Number.isFinite(normalized) && normalized > 0
                ? normalized
                : undefined;
        }
        return undefined;
    }
    describeTransportError(error) {
        if (!(error instanceof Error)) {
            return String(error);
        }
        const cause = error.cause;
        if (cause && typeof cause === "object") {
            const candidate = cause;
            const parts = [
                typeof candidate.message === "string" ? candidate.message : undefined,
                typeof candidate.code === "string" ? `code=${candidate.code}` : undefined,
                typeof candidate.errno === "number"
                    ? `errno=${candidate.errno}`
                    : undefined,
                typeof candidate.syscall === "string"
                    ? `syscall=${candidate.syscall}`
                    : undefined,
                typeof candidate.address === "string"
                    ? `address=${candidate.address}`
                    : undefined,
                typeof candidate.port === "number" ? `port=${candidate.port}` : undefined,
            ].filter((part) => Boolean(part));
            if (parts.length > 0) {
                return parts.join(", ");
            }
        }
        return error.message;
    }
}
exports.OllamaClient = OllamaClient;
//# sourceMappingURL=ollamaClient.js.map