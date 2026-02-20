"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaClient = void 0;
class OllamaClient {
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
            throw error;
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
                dispose: () => {
                    // no-op
                },
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
        const timer = setTimeout(() => {
            didTimeout = true;
            timeoutController.abort();
        }, effectiveTimeoutMs);
        return {
            signal: mergedController.signal,
            timeoutMs: effectiveTimeoutMs,
            didTimeout: () => didTimeout,
            dispose: () => {
                clearTimeout(timer);
                abortSignal.removeEventListener("abort", onParentAbort);
                timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
            },
        };
    }
}
exports.OllamaClient = OllamaClient;
//# sourceMappingURL=ollamaClient.js.map