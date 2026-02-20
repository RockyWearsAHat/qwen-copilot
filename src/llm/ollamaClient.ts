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

export interface ChatStreamChunk {
  done: boolean;
  message: LlmMessage;
}

export interface ChatStreamResult {
  stream: AsyncIterable<ChatStreamChunk>;
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
    context_length?: number | string;
  };
}

export class OllamaClient {
  public async getModelContextLength(
    endpoint: string,
    modelName: string,
    abortSignal: AbortSignal,
    timeoutMs?: number,
  ): Promise<number | undefined> {
    const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);

    let response: Response;
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
    } catch (error) {
      if (timeoutState.didTimeout()) {
        throw new Error(
          `Ollama model show timed out after ${timeoutState.timeoutMs}ms for '${modelName}'.`,
        );
      }
      throw error;
    } finally {
      timeoutState.dispose();
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama model show failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as {
      model_info?: Record<string, unknown>;
    };

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

  /**
   * Streaming version of chat.  Returns an async iterable of partial response
   * chunks so that the caller can report incremental text to Copilot as it
   * arrives — critical for not hitting the request timeout on large prompts.
   *
   * Ollama's streaming format sends one JSON object per line, each with a
   * `message.content` delta, and the final chunk has `done: true` plus a
   * full aggregated `message` with `tool_calls` if any.
   */
  public async chatStream(
    request: ChatRequest,
    abortSignal: AbortSignal,
    timeoutMs?: number,
  ): Promise<ChatStreamResult> {
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
        },
      );
    } catch (error) {
      timeoutState.dispose();
      if (timeoutState.didTimeout()) {
        throw new Error(
          `Ollama chat request timed out after ${timeoutState.timeoutMs}ms.`,
        );
      }
      throw error;
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

  private async *parseStreamBody(
    body: ReadableStream<Uint8Array>,
    timeoutState: ReturnType<OllamaClient["createTimeoutState"]>,
  ): AsyncIterable<ChatStreamChunk> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";

    try {
      while (true) {
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await reader.read();
        } catch (error) {
          if (timeoutState.didTimeout()) {
            throw new Error(
              `Ollama chat request timed out after ${timeoutState.timeoutMs}ms.`,
            );
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

          let chunk: {
            done?: boolean;
            message?: LlmMessage;
          };
          try {
            chunk = JSON.parse(trimmed);
          } catch {
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
    } finally {
      reader.releaseLock();
      timeoutState.dispose();
    }
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
    /** Reset the idle timer — call this whenever data arrives. */
    resetIdleTimer: () => void;
    dispose: () => void;
  } {
    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
    if (effectiveTimeoutMs <= 0) {
      return {
        signal: abortSignal,
        timeoutMs: 0,
        didTimeout: () => false,
        resetIdleTimer: () => {},
        dispose: () => {},
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

  private toPositiveInteger(value: unknown): number | undefined {
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
}
