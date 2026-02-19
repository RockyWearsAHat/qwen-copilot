"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaClient = void 0;
class OllamaClient {
    async chat(request, abortSignal) {
        const response = await fetch(`${request.endpoint.replace(/\/$/, '')}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: request.model,
                stream: false,
                messages: request.messages,
                tools: request.tools,
                options: {
                    temperature: request.temperature
                }
            }),
            signal: abortSignal
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Ollama request failed (${response.status}): ${text}`);
        }
        const payload = (await response.json());
        if (!payload.message) {
            throw new Error('Ollama response did not include a message payload.');
        }
        return { message: payload.message };
    }
    async listModels(endpoint, abortSignal) {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: abortSignal
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Ollama model listing failed (${response.status}): ${text}`);
        }
        const payload = (await response.json());
        return payload.models ?? [];
    }
}
exports.OllamaClient = OllamaClient;
//# sourceMappingURL=ollamaClient.js.map