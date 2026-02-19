export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface LlmToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  endpoint: string;
  temperature: number;
}

export interface ChatResult {
  message: LlmMessage;
}

export interface OllamaModelInfo {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export class OllamaClient {
  public async chat(
    request: ChatRequest,
    abortSignal: AbortSignal,
  ): Promise<ChatResult> {
    const response = await fetch(
      `${request.endpoint.replace(/\/$/, "")}/api/chat`,
      {
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
          },
        }),
        signal: abortSignal,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as { message?: LlmMessage };
    if (!payload.message) {
      throw new Error("Ollama response did not include a message payload.");
    }

    return { message: payload.message };
  }

  public async listModels(
    endpoint: string,
    abortSignal: AbortSignal,
  ): Promise<OllamaModelInfo[]> {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: abortSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Ollama model listing failed (${response.status}): ${text}`,
      );
    }

    const payload = (await response.json()) as { models?: OllamaModelInfo[] };
    return payload.models ?? [];
  }
}
