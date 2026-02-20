import { Agent, Client, Dispatcher, fetch as undiciFetch } from "undici";

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
  private static readonly transportDispatcher: Dispatcher = new Agent({
    factory: (origin, options) =>
      new Client(origin, {
        ...options,
        headersTimeout: 0,
        bodyTimeout: 0,
      }),
  });

  public async getModelContextLength(
    endpoint: string,
    modelName: string,
    abortSignal: AbortSignal,
    timeoutMs?: number,
  ): Promise<number | undefined> {
    const timeoutState = this.createTimeoutState(abortSignal, timeoutMs);

    let response: Response;
    try {
      response = await this.fetchWithTransportDispatcher(
        `${endpoint.replace(/\/$/, "")}/api/show`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: modelName,
          }),
          signal: timeoutState.signal,
        },
      );
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
      response = await this.fetchWithTransportDispatcher(
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
      throw new Error(
        `Ollama chat request transport failed for model '${request.model}' at '${request.endpoint}': ${this.describeTransportError(error)}`,
      );
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
      response = await this.fetchWithTransportDispatcher(
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
      throw new Error(
        `Ollama streaming chat transport failed for model '${request.model}' at '${request.endpoint}': ${this.describeTransportError(error)}`,
      );
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
          const parsed = this.tryParseStreamChunkLine(line);
          if (!parsed) {
            continue;
          }

          yield parsed;
        }

        if (done) {
          const trailing = this.tryParseStreamChunkLine(buffer);
          if (trailing) {
            yield trailing;
          }

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
      response = await this.fetchWithTransportDispatcher(
        `${endpoint.replace(/\/$/, "")}/api/tags`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          signal: timeoutState.signal,
        },
      );
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

  private describeTransportError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const candidate = cause as {
        code?: unknown;
        errno?: unknown;
        syscall?: unknown;
        address?: unknown;
        port?: unknown;
        message?: unknown;
      };
      const parts = [
        typeof candidate.message === "string" ? candidate.message : undefined,
        typeof candidate.code === "string"
          ? `code=${candidate.code}`
          : undefined,
        typeof candidate.errno === "number"
          ? `errno=${candidate.errno}`
          : undefined,
        typeof candidate.syscall === "string"
          ? `syscall=${candidate.syscall}`
          : undefined,
        typeof candidate.address === "string"
          ? `address=${candidate.address}`
          : undefined,
        typeof candidate.port === "number"
          ? `port=${candidate.port}`
          : undefined,
      ].filter((part): part is string => Boolean(part));

      if (parts.length > 0) {
        return parts.join(", ");
      }
    }

    return error.message;
  }

  private tryParseStreamChunkLine(line: string): ChatStreamChunk | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    // Accept SSE-style payloads (`data: {...}`) in addition to raw NDJSON.
    const candidate = trimmed.startsWith("data:")
      ? trimmed.slice(5).trim()
      : trimmed;

    if (candidate.length === 0 || candidate === "[DONE]") {
      return undefined;
    }

    let payload: {
      done?: boolean;
      message?: LlmMessage;
    };
    try {
      payload = JSON.parse(candidate);
    } catch {
      return undefined;
    }

    if (!payload.message) {
      return undefined;
    }

    return {
      done: payload.done ?? false,
      message: payload.message,
    };
  }

  private fetchWithTransportDispatcher(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    return undiciFetch(
      input as unknown as any,
      {
        ...init,
        headersTimeout: 0,
        bodyTimeout: 0,
        dispatcher: OllamaClient.transportDispatcher,
      } as unknown as import("undici").RequestInit,
    ) as unknown as Promise<Response>;
  }
}
