"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
function activate(context) {
    console.log("Ollama provider activated");
    const provider = {
        async provideChatResponse(request, ctx, stream, token) {
            try {
                // Build prompt from conversation
                const prompt = request.messages.map((m) => m.content).join("\n");
                const res = await fetch("http://localhost:11434/api/generate", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: "gemma4:e2b",
                        prompt,
                        stream: true
                    }),
                    signal: token
                });
                if (!res.body) {
                    stream.markdown("No response from Ollama");
                    return;
                }
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
                        try {
                            const json = JSON.parse(line);
                            if (json.response) {
                                stream.markdown(json.response);
                            }
                        }
                        catch {
                            // ignore malformed chunks
                        }
                    }
                }
            }
            catch (err) {
                stream.markdown("Error: " + err.message);
            }
        }
    };
    const registration = vscode.chat.registerChatProvider("ollama-provider", provider, {
        displayName: "Ollama",
        description: "Local Ollama models"
    });
    context.subscriptions.push(registration);
}
function deactivate() { }
