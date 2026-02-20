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
  images?: string[];
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
  maxOutputTokens?: number;
  contextWindowTokens?: number;
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
    timeoutMs?: number,
  ): Promise<ChatResult> {
    const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);

    let response: Response;
    try {
      response = await fetch(
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
        },
      );
    } catch (error) {
      if (timeoutState.didTimeout()) {
        throw new Error(
          `Ollama chat request timed out after ${timeoutState.timeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      timeoutState.dispose();
    }

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
    timeoutMs?: number,
  ): Promise<OllamaModelInfo[]> {
    const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal: timeoutState.signal,
      });
    } catch (error) {
      if (timeoutState.didTimeout()) {
        throw new Error(
          `Ollama model listing timed out after ${timeoutState.timeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      timeoutState.dispose();
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Ollama model listing failed (${response.status}): ${text}`,
      );
    }

    const payload = (await response.json()) as { models?: OllamaModelInfo[] };
    return payload.models ?? [];
  }

  private createTimeoutState(
    abortSignal: AbortSignal,
    timeoutMs?: number,
  ): {
    signal: AbortSignal;
    timeoutMs: number;
    didTimeout: () => boolean;
    dispose: () => void;
  } {
    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
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
    } else {
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
