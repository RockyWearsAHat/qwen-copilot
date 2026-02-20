import * as vscode from "vscode";
import {
  ChatRequest,
  LlmMessage,
  LlmToolSpec,
  OllamaModelInfo,
  OllamaClient,
  ToolCall,
} from "./ollamaClient";

interface LocalLanguageModelInfo extends vscode.LanguageModelChatInformation {
  ollamaName: string;
}

export class LocalLanguageModelProvider implements vscode.LanguageModelChatProvider<LocalLanguageModelInfo> {
  private static readonly toolCallStart = "<local_qwen_tool_call>";
  private static readonly toolCallEnd = "</local_qwen_tool_call>";
  private static readonly defaultContextLength = 32768;
  private static readonly inputBudgetRatio = 0.6;
  private static readonly defaultEndpoint = "http://localhost:11434";
  private static readonly defaultModel = "qwen2.5:32b";
  private static readonly defaultTemperature = 0.2;
  private static readonly defaultModelListTimeoutMs = 7000;
  private static readonly defaultModelListCacheTtlMs = 10000;
  private static readonly maxInitialTools = 24;

  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeLanguageModelChatInformation =
    this.modelInfoChangedEmitter.event;
  private readonly client = new OllamaClient();
  private cachedModelInfos?: {
    expiresAt: number;
    infos: LocalLanguageModelInfo[];
  };
  private inFlightModelInfoRequest?: Promise<LocalLanguageModelInfo[]>;
  private activeChatRequests = 0;
  private readonly chatWaiters: Array<() => void> = [];

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async warmModelInfos(): Promise<void> {
    const endpoint = LocalLanguageModelProvider.defaultEndpoint;
    const fallbackModel = LocalLanguageModelProvider.defaultModel;

    try {
      await this.fetchModelInfos(endpoint, fallbackModel);
      this.modelInfoChangedEmitter.fire();
    } catch {
      // fetchModelInfos already emits fallback and logs failures.
      this.modelInfoChangedEmitter.fire();
    }
  }

  public invalidateModelInfos(): void {
    this.cachedModelInfos = undefined;
    this.inFlightModelInfoRequest = undefined;
  }

  public dispose(): void {
    this.modelInfoChangedEmitter.dispose();
  }

  public async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<LocalLanguageModelInfo[]> {
    const endpoint = LocalLanguageModelProvider.defaultEndpoint;
    const fallbackModel = LocalLanguageModelProvider.defaultModel;

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const cached = this.getCachedModelInfos();
    if (cached) {
      return cached;
    }

    if (!this.inFlightModelInfoRequest) {
      this.inFlightModelInfoRequest = this.fetchModelInfos(
        endpoint,
        fallbackModel,
      ).finally(() => {
        this.inFlightModelInfoRequest = undefined;
      });
    }

    return this.inFlightModelInfoRequest;
  }

  /**
   * Transparent bridge: forward everything Copilot sends to Ollama, return
   * everything Ollama gives back. Copilot's agent orchestrator handles tool
   * selection, history management, context assembly, and the tool-calling
   * loop — exactly like it does for Claude, GPT, and Gemini providers.
   */
  public async provideLanguageModelChatResponse(
    model: LocalLanguageModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const endpoint = LocalLanguageModelProvider.defaultEndpoint;
    const temperature = LocalLanguageModelProvider.defaultTemperature;
    const timeoutMs = 0;
    const maxConcurrentRequests = 1;
    const logRequestStats = true;

    // Derive num_ctx and num_predict from the model info that Copilot
    // already received via provideLanguageModelChatInformation.
    // model.maxInputTokens + model.maxOutputTokens = the full context window.
    const contextWindowTokens = model.maxInputTokens + model.maxOutputTokens;
    const maxOutputTokens = model.maxOutputTokens;

    const abortController = this.createAbortController(token);

    // Convert VS Code message format to Ollama format.
    const convertedMessages = messages.map((message) =>
      this.convertRequestMessage(message, true),
    );

    if (convertedMessages.length > 0) {
      const firstMessage = convertedMessages[0];
      const sanitizedFirst = this.sanitizeCopilotPreambleMessage(
        firstMessage.content,
        true,
        true,
        false,
      );

      if (sanitizedFirst !== firstMessage.content) {
        firstMessage.content = sanitizedFirst;
        this.output.appendLine(
          "[local-qwen] sanitized Copilot preamble while preserving tool instructions.",
        );
      }
    }

    // Debug: dump outbound messages to file for inspection
    if (convertedMessages.length > 0) {
      try {
        const fs = require("fs");
        const debugPayload = convertedMessages
          .map((message, index) => {
            const header = `--- message[${index}] role=${message.role} ---`;
            return `${header}\n${message.content}`;
          })
          .join("\n\n");
        fs.writeFileSync(
          "/tmp/copilot-system-prompt-debug.txt",
          debugPayload,
          "utf8",
        );
        this.output.appendLine(
          `[local-qwen] DEBUG: wrote ${convertedMessages.length} outbound messages to /tmp/copilot-system-prompt-debug.txt`,
        );
      } catch {
        // ignore write errors
      }
    }

    // Convert VS Code tool definitions to Ollama format — pass them all
    // through.  Copilot already selected which tools are relevant for this
    // turn of its agent loop.
    const tools = this.toOllamaToolSpecs(options.tools ?? []);
    const prioritizedTools = this.prioritizeToolsForIntent(
      tools,
      convertedMessages,
    );
    const initialTools = this.selectInitialToolSubset(
      prioritizedTools,
      convertedMessages,
    );
    const shouldPreferToolCalls =
      this.shouldPreferToolCalls(convertedMessages) && initialTools.length > 0;
    const shouldRetryAfterNoToolCall =
      initialTools.length > 0 &&
      (shouldPreferToolCalls || initialTools.length < prioritizedTools.length);

    const request: ChatRequest = {
      endpoint,
      model: model.ollamaName || model.id,
      temperature,
      maxOutputTokens,
      contextWindowTokens, // Always sent — Ollama defaults to 2048 otherwise!
      messages: convertedMessages,
      tools: initialTools,
    };

    try {
      const fs = require("fs");
      fs.writeFileSync(
        "/tmp/copilot-ollama-request-debug.json",
        JSON.stringify(
          {
            endpoint,
            model: request.model,
            temperature,
            maxOutputTokens,
            contextWindowTokens,
            messages: request.messages,
            tools: request.tools,
          },
          null,
          2,
        ),
        "utf8",
      );
      this.output.appendLine(
        `[local-qwen] DEBUG: wrote full request payload to /tmp/copilot-ollama-request-debug.json (tools=${request.tools.length})`,
      );
    } catch {
      // ignore write errors
    }

    if (logRequestStats) {
      const messageChars = convertedMessages.reduce(
        (sum, message) => sum + this.estimateMessageSize(message),
        0,
      );
      const toolChars = JSON.stringify(initialTools).length;
      const approxPromptTokens = Math.ceil((messageChars + toolChars) / 4);
      this.output.appendLine(
        `[local-qwen] request: messages=${convertedMessages.length}, tools=${initialTools.length}, ~${approxPromptTokens} prompt tokens, modelMaxInput=${model.maxInputTokens}, num_ctx=${contextWindowTokens}, num_predict=${maxOutputTokens}`,
      );
    }

    await this.acquireChatSlot(Math.max(1, maxConcurrentRequests), token);

    try {
      const firstAttempt = await this.streamResponse(
        request,
        initialTools,
        abortController,
        timeoutMs,
        progress,
        !shouldPreferToolCalls,
        !shouldPreferToolCalls,
      );

      if (
        shouldRetryAfterNoToolCall &&
        !firstAttempt.emittedToolCalls &&
        !token.isCancellationRequested
      ) {
        const fallbackMessages = this.withToolTextFallbackMessages(
          request.messages,
          prioritizedTools,
        );
        this.output.appendLine(
          `[local-qwen] no tool call detected on first pass; retrying with explicit tool-call fallback instructions (initialTools=${initialTools.length}, retryTools=${prioritizedTools.length}).`,
        );

        await this.streamResponse(
          { ...request, tools: prioritizedTools, messages: fallbackMessages },
          prioritizedTools,
          abortController,
          timeoutMs,
          progress,
          false,
          true,
        );
      }
    } catch (error) {
      if (!this.shouldRetryWithoutTools(error, request.tools)) {
        throw error;
      }

      // Model does not support native tool calling — retry without the
      // native schema and provide explicit text instructions for tool calls.
      this.output.appendLine(
        `[local-qwen] model '${request.model}' does not support native tools; retrying without tool schema.`,
      );

      const fallbackMessages = this.withToolTextFallbackMessages(
        request.messages,
        prioritizedTools,
      );

      await this.streamResponse(
        { ...request, tools: [], messages: fallbackMessages },
        prioritizedTools,
        abortController,
        timeoutMs,
        progress,
        false,
        true,
      );
    } finally {
      this.releaseChatSlot();
    }
  }

  /**
   * Stream from Ollama and report text/tool-call parts to Copilot as they
   * arrive.  Text content is streamed incrementally so the UI stays
   * responsive.  Tool calls (native or parsed from text) are emitted once
   * the stream is complete since they must be structurally whole.
   */
  private async streamResponse(
    request: ChatRequest,
    allToolSpecs: LlmToolSpec[],
    abortController: AbortController,
    timeoutMs: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    streamTextDeltas: boolean,
    emitTextWhenNoToolCall: boolean,
  ): Promise<{ emittedToolCalls: boolean; fullContentLength: number }> {
    let fullContent = "";
    let nativeToolCalls: ToolCall[] = [];
    const nativeToolFingerprints = new Set<string>();
    let streamed = false;
    const startedAt = Date.now();
    let sawFirstChunk = false;
    let sawFirstTextDelta = false;
    let chunkCount = 0;

    try {
      this.output.appendLine(
        `[local-qwen] opening stream request for '${request.model}'...`,
      );

      const { stream } = await this.client.chatStream(
        request,
        abortController.signal,
        timeoutMs,
      );

      this.output.appendLine(
        `[local-qwen] stream opened for '${request.model}' after ${Date.now() - startedAt}ms`,
      );

      streamed = true;

      for await (const chunk of stream) {
        chunkCount += 1;
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          this.output.appendLine(
            `[local-qwen] first stream chunk after ${Date.now() - startedAt}ms`,
          );
        }

        const delta = chunk.message.content ?? "";

        if (delta.length > 0) {
          fullContent += delta;
          if (!sawFirstTextDelta) {
            sawFirstTextDelta = true;
            this.output.appendLine(
              `[local-qwen] first text delta after ${Date.now() - startedAt}ms`,
            );
          }
          if (streamTextDeltas) {
            progress.report(new vscode.LanguageModelTextPart(delta));
          }
        }

        if (chunk.message.tool_calls?.length) {
          for (const toolCall of chunk.message.tool_calls) {
            const fingerprint = JSON.stringify({
              name: toolCall.function?.name,
              arguments: toolCall.function?.arguments ?? {},
              id: toolCall.id ?? "",
            });
            if (nativeToolFingerprints.has(fingerprint)) {
              continue;
            }
            nativeToolFingerprints.add(fingerprint);
            nativeToolCalls.push(toolCall);
          }
        }
      }

      this.output.appendLine(
        `[local-qwen] stream completed in ${Date.now() - startedAt}ms with ${chunkCount} chunk(s), textChars=${fullContent.length}, nativeToolCalls=${nativeToolCalls.length}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.output.appendLine(
        `[local-qwen] stream failed after ${Date.now() - startedAt}ms: ${detail}`,
      );
      if (!this.shouldFallbackToNonStreaming(error)) {
        throw error;
      }

      this.output.appendLine(
        `[local-qwen] stream unavailable; retrying non-stream chat: ${detail}`,
      );

      const nonStream = await this.client.chat(
        request,
        abortController.signal,
        timeoutMs,
      );
      fullContent = nonStream.message.content ?? "";
      nativeToolCalls = nonStream.message.tool_calls ?? [];
    }

    if (!streamed && streamTextDeltas && fullContent.trim().length > 0) {
      progress.report(new vscode.LanguageModelTextPart(fullContent));
    }

    // If the model returned native tool calls, emit them.  Otherwise try
    // to parse tool calls from the full text content.
    if (nativeToolCalls.length > 0) {
      // The text was already streamed but if the model ONLY returned
      // tool calls (no meaningful text), that's fine — Copilot handles it.
      for (const toolCall of nativeToolCalls) {
        const toolInput = this.parseToolArgs(toolCall);
        progress.report(
          new vscode.LanguageModelToolCallPart(
            toolCall.id ?? this.nextCallId(),
            toolCall.function.name,
            toolInput,
          ),
        );
      }
      return {
        emittedToolCalls: true,
        fullContentLength: fullContent.length,
      };
    }

    // No native tool calls — try to recover tool calls from the text
    if (fullContent.trim().length > 0) {
      let parsedToolCalls: ToolCall[] = [];
      let cleanedContent = fullContent;

      const delimiterParse = this.extractDelimitedToolCalls(fullContent);
      if (delimiterParse.toolCalls.length > 0) {
        parsedToolCalls = delimiterParse.toolCalls;
        cleanedContent = delimiterParse.cleanedContent;
      } else {
        const structuredParse = this.extractStructuredToolCalls(fullContent);
        if (structuredParse.toolCalls.length > 0) {
          parsedToolCalls = structuredParse.toolCalls;
          cleanedContent = structuredParse.cleanedContent;
        } else {
          const functionTagParse =
            this.extractFunctionTagToolCalls(fullContent);
          if (functionTagParse.toolCalls.length > 0) {
            parsedToolCalls = functionTagParse.toolCalls;
            cleanedContent = functionTagParse.cleanedContent;
          }
        }
      }

      if (parsedToolCalls.length > 0) {
        const allowedToolNames = new Set(
          allToolSpecs.map((tool) => tool.function.name),
        );
        const dedupedToolCalls: ToolCall[] = [];
        const seenToolCalls = new Set<string>();

        for (const toolCall of parsedToolCalls) {
          const toolName = toolCall.function.name;
          if (!allowedToolNames.has(toolName)) {
            continue;
          }

          const argsFingerprint =
            typeof toolCall.function.arguments === "string"
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments ?? {});
          const fingerprint = `${toolName}:${argsFingerprint}`;
          if (seenToolCalls.has(fingerprint)) {
            continue;
          }

          seenToolCalls.add(fingerprint);
          dedupedToolCalls.push(toolCall);
        }

        if (dedupedToolCalls.length !== parsedToolCalls.length) {
          this.output.appendLine(
            `[local-qwen] deduped parsed tool calls (${parsedToolCalls.length} → ${dedupedToolCalls.length}).`,
          );
        }

        if (parsedToolCalls.length > 0 && dedupedToolCalls.length === 0) {
          const attemptedNames = [
            ...new Set(parsedToolCalls.map((call) => call.function.name)),
          ];
          this.output.appendLine(
            `[local-qwen] parsed tool calls were dropped because names were not in allowed tool set: ${attemptedNames.join(", ")}`,
          );
        }

        for (const toolCall of dedupedToolCalls) {
          const toolInput = this.parseToolArgs(toolCall);
          progress.report(
            new vscode.LanguageModelToolCallPart(
              toolCall.id ?? this.nextCallId(),
              toolCall.function.name,
              toolInput,
            ),
          );
        }

        if (
          !streamTextDeltas &&
          emitTextWhenNoToolCall &&
          cleanedContent.trim().length > 0
        ) {
          progress.report(new vscode.LanguageModelTextPart(cleanedContent));
        }
        return {
          emittedToolCalls: true,
          fullContentLength: fullContent.length,
        };
      }

      if (!streamTextDeltas && emitTextWhenNoToolCall) {
        progress.report(new vscode.LanguageModelTextPart(fullContent));
      }
    }

    return {
      emittedToolCalls: false,
      fullContentLength: fullContent.length,
    };
  }

  private shouldFallbackToNonStreaming(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    const normalized = text.toLowerCase();

    // Only fallback when streaming is genuinely unavailable in runtime,
    // not on transport/header timeouts where a non-stream retry usually
    // hangs and surfaces as a worse error.
    return (
      normalized.includes("streaming unavailable") ||
      normalized.includes("response body is null") ||
      normalized.includes("not implemented")
    );
  }

  public async provideTokenCount(
    _model: LocalLanguageModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const raw =
      typeof text === "string"
        ? text
        : text.content.map((part) => this.partToText(part)).join(" ");
    return Math.max(1, Math.ceil(raw.length / 4));
  }

  private createFallbackInfo(model: string): LocalLanguageModelInfo {
    const tokenCaps = this.getAdvertisedTokenCaps();

    return {
      id: model,
      name: model,
      family: this.inferFamily(model),
      version: "local",
      detail: "configured default",
      tooltip: `Local Ollama model: ${model}`,
      maxInputTokens: tokenCaps.maxInputTokens,
      maxOutputTokens: tokenCaps.maxOutputTokens,
      capabilities: {
        toolCalling: true,
      },
      ollamaName: model,
    };
  }

  private async fetchModelInfos(
    endpoint: string,
    fallbackModel: string,
  ): Promise<LocalLanguageModelInfo[]> {
    const modelListTimeoutMs =
      LocalLanguageModelProvider.defaultModelListTimeoutMs;

    const ttlMs = LocalLanguageModelProvider.defaultModelListCacheTtlMs;

    const controller = new AbortController();

    try {
      const models = await this.client.listModels(
        endpoint,
        controller.signal,
        modelListTimeoutMs,
      );
      const modelsWithContext = await this.hydrateMissingContextLengths(
        models,
        endpoint,
        controller.signal,
        modelListTimeoutMs,
      );

      const infos =
        modelsWithContext.length === 0
          ? [this.createFallbackInfo(fallbackModel)]
          : modelsWithContext.map((model) => {
              const id = model.model ?? model.name;
              const family =
                model.details?.family ?? this.inferFamily(model.name);
              const tokenCaps = this.getAdvertisedTokenCaps(model.details);
              const detailParts = [
                model.details?.parameter_size,
                model.details?.quantization_level,
              ].filter(Boolean);

              return {
                id,
                name: model.name,
                family,
                version: model.modified_at ?? "local",
                detail: detailParts.join(" · ") || "local model",
                tooltip: `Local Ollama model: ${model.name}`,
                maxInputTokens: tokenCaps.maxInputTokens,
                maxOutputTokens: tokenCaps.maxOutputTokens,
                capabilities: {
                  toolCalling: true,
                  imageInput: family.includes("vl"),
                },
                ollamaName: model.name,
              } satisfies LocalLanguageModelInfo;
            });

      this.cachedModelInfos = {
        expiresAt: Date.now() + Math.max(1000, ttlMs),
        infos,
      };

      return infos;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[local-qwen] model listing failed: ${text}`);

      const fallbackInfos = [this.createFallbackInfo(fallbackModel)];
      this.cachedModelInfos = {
        expiresAt: Date.now() + Math.max(1000, ttlMs),
        infos: fallbackInfos,
      };

      return fallbackInfos;
    }
  }

  private async hydrateMissingContextLengths(
    models: readonly OllamaModelInfo[],
    endpoint: string,
    abortSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<OllamaModelInfo[]> {
    const enriched = await Promise.all(
      models.map(async (model) => {
        const hasContextLength = this.extractModelContextLength(model.details);
        if (hasContextLength) {
          return model;
        }

        try {
          const contextLength = await this.client.getModelContextLength(
            endpoint,
            model.name,
            abortSignal,
            timeoutMs,
          );

          if (!contextLength) {
            return model;
          }

          return {
            ...model,
            details: {
              ...model.details,
              context_length: contextLength,
            },
          };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.output.appendLine(
            `[local-qwen] unable to resolve context length via /api/show for '${model.name}': ${text}`,
          );
          return model;
        }
      }),
    );

    return enriched;
  }

  private getCachedModelInfos(): LocalLanguageModelInfo[] | undefined {
    if (!this.cachedModelInfos) {
      return undefined;
    }

    if (this.cachedModelInfos.expiresAt < Date.now()) {
      this.cachedModelInfos = undefined;
      return undefined;
    }

    return this.cachedModelInfos.infos;
  }

  /**
   * Compute the maxInputTokens and maxOutputTokens to advertise to Copilot.
   *
   * Local long-context workflows need far larger generation windows than the
   * old 4k output cap. We budget the context window as:
   *   maxInputTokens   = 60% of contextLength
   *   maxOutputTokens  = 40% of contextLength
   */
  private getAdvertisedTokenCaps(modelDetails?: unknown): {
    maxInputTokens: number;
    maxOutputTokens: number;
  } {
    const modelContextLength = this.extractModelContextLength(modelDetails);

    const contextLength =
      modelContextLength ?? LocalLanguageModelProvider.defaultContextLength;

    const maxInputTokens = Math.floor(
      contextLength * LocalLanguageModelProvider.inputBudgetRatio,
    );
    const maxOutputTokens = contextLength - maxInputTokens;

    return {
      maxInputTokens: Math.max(1024, maxInputTokens),
      maxOutputTokens: Math.max(256, maxOutputTokens),
    };
  }

  private extractModelContextLength(
    modelDetails?: unknown,
  ): number | undefined {
    if (!modelDetails || typeof modelDetails !== "object") {
      return undefined;
    }

    const contextLength = (modelDetails as { context_length?: unknown })
      .context_length;

    if (typeof contextLength === "number" && Number.isFinite(contextLength)) {
      return contextLength > 0 ? Math.floor(contextLength) : undefined;
    }

    if (typeof contextLength === "string") {
      const parsed = Number.parseInt(contextLength, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }

    return undefined;
  }

  private inferFamily(modelName: string): string {
    const lower = modelName.toLowerCase();
    if (lower.includes("qwen")) {
      return "qwen";
    }
    if (lower.includes("llama")) {
      return "llama";
    }
    if (lower.includes("deepseek")) {
      return "deepseek";
    }
    return "local";
  }

  /**
   * Convert VS Code tool definitions to Ollama-compatible tool specs.
   * Always sends the full schema — Copilot decides which tools to include.
   */
  private toOllamaToolSpecs(
    tools: readonly vscode.LanguageModelChatTool[],
  ): LlmToolSpec[] {
    const defaultParams: Record<string, unknown> = {
      type: "object",
      additionalProperties: true,
    };

    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? defaultParams) as Record<
          string,
          unknown
        >,
      },
    }));
  }

  private prioritizeToolsForIntent(
    tools: readonly LlmToolSpec[],
    messages: readonly LlmMessage[],
  ): LlmToolSpec[] {
    const latestUserText =
      this.getLatestUserMessageText(messages).toLowerCase();
    if (!latestUserText) {
      return [...tools];
    }

    const installIntent =
      /\b(install|setup|set up|configure|download|pull)\b/i.test(
        latestUserText,
      );
    const localRuntimeIntent = /\b(ollama|qwen|llama|deepseek|model)\b/i.test(
      latestUserText,
    );

    if (!(installIntent && localRuntimeIntent)) {
      return [...tools];
    }

    const priority = (name: string): number => {
      if (name === "run_in_terminal") {
        return 0;
      }
      if (
        name === "await_terminal" ||
        name === "get_terminal_output" ||
        name === "terminal_last_command"
      ) {
        return 1;
      }
      if (name === "ask_questions") {
        return 99;
      }
      return 10;
    };

    const sorted = [...tools].sort(
      (left, right) =>
        priority(left.function.name) - priority(right.function.name),
    );

    this.output.appendLine(
      "[local-qwen] intent bias: prioritized terminal tools and de-prioritized ask_questions for install/runtime request.",
    );

    return sorted;
  }

  private selectInitialToolSubset(
    tools: readonly LlmToolSpec[],
    messages: readonly LlmMessage[],
  ): LlmToolSpec[] {
    if (tools.length <= LocalLanguageModelProvider.maxInitialTools) {
      return [...tools];
    }

    const latestUserText =
      this.getLatestUserMessageText(messages).toLowerCase();
    const tokens = Array.from(
      new Set(latestUserText.match(/[a-z][a-z0-9_-]{2,}/g) ?? []),
    );

    const preferredNames = new Set<string>();
    const addIfPresent = (name: string) => {
      if (tools.some((tool) => tool.function.name === name)) {
        preferredNames.add(name);
      }
    };

    const baseline = [
      "run_in_terminal",
      "read_file",
      "grep_search",
      "file_search",
      "get_errors",
      "get_changed_files",
      "apply_patch",
      "manage_todo_list",
    ];
    for (const toolName of baseline) {
      addIfPresent(toolName);
    }

    if (
      /replay|log|debug|timeout|slow|failing|not working|error/i.test(
        latestUserText,
      )
    ) {
      addIfPresent("get_terminal_output");
      addIfPresent("terminal_last_command");
      addIfPresent("await_terminal");
    }

    const scored = tools.map((tool, index) => {
      const name = tool.function.name.toLowerCase();
      const description = (tool.function.description ?? "").toLowerCase();
      let score = 0;

      if (preferredNames.has(tool.function.name)) {
        score += 20;
      }

      for (const token of tokens) {
        if (name.includes(token)) {
          score += 8;
        }
        if (description.includes(token)) {
          score += 2;
        }
      }

      return { tool, index, score };
    });

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });

    const selected = scored
      .slice(0, LocalLanguageModelProvider.maxInitialTools)
      .map((entry) => entry.tool);

    this.output.appendLine(
      `[local-qwen] tool subset: selected ${selected.length}/${tools.length} tools for first pass.`,
    );

    return selected;
  }

  private shouldPreferToolCalls(messages: readonly LlmMessage[]): boolean {
    const latestUserText =
      this.getLatestUserMessageText(messages).toLowerCase();
    if (!latestUserText) {
      return false;
    }

    return /\b(fix|debug|investigate|analyze|check|run|replay|test|build|compile|install|search|open|read|edit|change|update|create|implement|make|transform|convert|turn into|turn this into|set up|setup)\b/i.test(
      latestUserText,
    );
  }

  private getLatestUserMessageText(messages: readonly LlmMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user" && messages[index].content.trim()) {
        return messages[index].content;
      }
    }
    return "";
  }

  private withToolTextFallbackMessages(
    messages: readonly LlmMessage[],
    tools: readonly LlmToolSpec[],
  ): LlmMessage[] {
    if (tools.length === 0) {
      return [...messages];
    }

    const toolSummary = tools
      .map(
        (tool) =>
          `- ${tool.function.name}: ${tool.function.description || "No description provided."}`,
      )
      .join("\n");

    const instruction: LlmMessage = {
      role: "system",
      content: [
        "Native tool calling is unavailable for this model.",
        "When you need a tool, output ONLY the following XML block format and no surrounding markdown:",
        '<local_qwen_tool_call>{"name":"tool_name","arguments":{}}</local_qwen_tool_call>',
        "You may output multiple blocks back-to-back if needed.",
        "Available tools:",
        toolSummary,
      ].join("\n"),
    };

    return [...messages, instruction];
  }

  private extractDelimitedToolCalls(content: string): {
    cleanedContent: string;
    toolCalls: ToolCall[];
  } {
    const start = LocalLanguageModelProvider.toolCallStart;
    const end = LocalLanguageModelProvider.toolCallEnd;
    const expression = new RegExp(`${start}([\\s\\S]*?)${end}`, "g");

    const toolCalls: ToolCall[] = [];
    let cleaned = content;
    const matches = Array.from(content.matchAll(expression));

    for (const match of matches) {
      const payloadText = match[1]?.trim();
      if (!payloadText) {
        continue;
      }

      try {
        const payload = JSON.parse(payloadText) as {
          name?: unknown;
          arguments?: unknown;
          input?: unknown;
        };
        const name =
          typeof payload.name === "string" ? payload.name.trim() : "";
        if (!name) {
          continue;
        }

        const args =
          payload.arguments ?? payload.input ?? ({} as Record<string, unknown>);

        toolCalls.push({
          id: this.nextCallId(),
          function: {
            name,
            arguments:
              typeof args === "string" ||
              (args && typeof args === "object" && !Array.isArray(args))
                ? (args as string | Record<string, unknown>)
                : {},
          },
        });
      } catch {
        continue;
      }
    }

    if (matches.length > 0) {
      cleaned = content.replace(expression, "").trim();
    }

    return {
      cleanedContent: cleaned,
      toolCalls,
    };
  }

  private extractStructuredToolCalls(content: string): {
    cleanedContent: string;
    toolCalls: ToolCall[];
  } {
    const trimmed = content.trim();
    if (!trimmed) {
      return {
        cleanedContent: content,
        toolCalls: [],
      };
    }

    const candidates: string[] = [trimmed];
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      candidates.push(fencedMatch[1].trim());
    }

    const fencedExpression = /```(?:json)?\s*([\s\S]*?)```/gi;
    const fencedMatches = Array.from(trimmed.matchAll(fencedExpression));
    if (fencedMatches.length > 0) {
      const aggregatedToolCalls: ToolCall[] = [];

      for (const match of fencedMatches) {
        const payload = match[1]?.trim();
        if (!payload) {
          continue;
        }

        try {
          const parsed = JSON.parse(payload) as unknown;
          aggregatedToolCalls.push(
            ...this.toToolCallsFromStructuredPayload(parsed),
          );
        } catch {
          continue;
        }
      }

      if (aggregatedToolCalls.length > 0) {
        const cleanedContent = trimmed.replace(fencedExpression, "").trim();
        return {
          cleanedContent,
          toolCalls: aggregatedToolCalls,
        };
      }
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const toolCalls = this.toToolCallsFromStructuredPayload(parsed);
        if (toolCalls.length > 0) {
          return {
            cleanedContent: "",
            toolCalls,
          };
        }
      } catch {
        // no-op: not valid JSON
      }
    }

    return {
      cleanedContent: content,
      toolCalls: [],
    };
  }

  private extractFunctionTagToolCalls(content: string): {
    cleanedContent: string;
    toolCalls: ToolCall[];
  } {
    const functionExpression =
      /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/function>/gi;
    const parameterExpression =
      /<parameter=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/parameter>/gi;

    const toolCalls: ToolCall[] = [];
    const functionMatches = Array.from(content.matchAll(functionExpression));

    for (const match of functionMatches) {
      const functionName = match[1]?.trim();
      const body = match[2] ?? "";
      if (!functionName) {
        continue;
      }

      const args: Record<string, unknown> = {};
      const parameterMatches = Array.from(body.matchAll(parameterExpression));
      for (const parameterMatch of parameterMatches) {
        const key = parameterMatch[1]?.trim();
        const rawValue = parameterMatch[2]?.trim();
        if (!key || !rawValue) {
          continue;
        }

        args[key] = this.parseFunctionTagValue(rawValue);
      }

      toolCalls.push({
        id: this.nextCallId(),
        function: {
          name: functionName,
          arguments: args,
        },
      });
    }

    if (toolCalls.length === 0) {
      return {
        cleanedContent: content,
        toolCalls: [],
      };
    }

    return {
      cleanedContent: content.replace(functionExpression, "").trim(),
      toolCalls,
    };
  }

  private parseFunctionTagValue(rawValue: string): unknown {
    try {
      return JSON.parse(rawValue);
    } catch {
      const numberValue = Number(rawValue);
      if (Number.isFinite(numberValue)) {
        return numberValue;
      }

      const lowered = rawValue.toLowerCase();
      if (lowered === "true") {
        return true;
      }
      if (lowered === "false") {
        return false;
      }
      if (lowered === "null") {
        return null;
      }

      return rawValue;
    }
  }

  private toToolCallsFromStructuredPayload(payload: unknown): ToolCall[] {
    if (!payload) {
      return [];
    }

    if (Array.isArray(payload)) {
      return payload
        .map((entry) => this.toToolCallFromStructuredPayload(entry))
        .filter((entry): entry is ToolCall => Boolean(entry));
    }

    const single = this.toToolCallFromStructuredPayload(payload);
    return single ? [single] : [];
  }

  private toToolCallFromStructuredPayload(
    payload: unknown,
  ): ToolCall | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    const candidate = payload as {
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      function?: {
        name?: unknown;
        arguments?: unknown;
      };
    };

    const functionName =
      typeof candidate.function?.name === "string"
        ? candidate.function.name.trim()
        : typeof candidate.name === "string"
          ? candidate.name.trim()
          : "";

    if (!functionName) {
      return undefined;
    }

    const rawArgs =
      candidate.function?.arguments ?? candidate.arguments ?? candidate.input;

    const normalizedArgs =
      typeof rawArgs === "string" ||
      (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
        ? (rawArgs as string | Record<string, unknown>)
        : {};

    return {
      id: this.nextCallId(),
      function: {
        name: functionName,
        arguments: normalizedArgs,
      },
    };
  }

  private estimateMessageSize(message: LlmMessage): number {
    const contentSize = message.content.length;
    const toolCallSize = JSON.stringify(message.tool_calls ?? []).length;
    const imageSize = (message.images?.length ?? 0) * 500;
    return contentSize + toolCallSize + imageSize + 24;
  }

  private convertRequestMessage(
    message: vscode.LanguageModelChatRequestMessage,
    compactEnvelopeMessages: boolean,
  ): LlmMessage {
    const textSegments: string[] = [];
    const images: string[] = [];

    for (const part of message.content) {
      const imageBase64 = this.extractImageBase64(part);
      if (imageBase64) {
        images.push(imageBase64);
        continue;
      }

      const text = this.partToText(part).trim();
      if (text.length > 0) {
        textSegments.push(text);
      }
    }

    const rawContent = textSegments.join("\n").trim();

    const mappedRole = this.mapMessageRole(message.role);
    const content =
      compactEnvelopeMessages && mappedRole === "user"
        ? this.compactEnvelopeUserMessage(rawContent)
        : rawContent;

    const assistantToolCalls =
      mappedRole === "assistant"
        ? message.content
            .filter(
              (part): part is vscode.LanguageModelToolCallPart =>
                part instanceof vscode.LanguageModelToolCallPart,
            )
            .map((part) => ({
              id: part.callId,
              function: {
                name: part.name,
                arguments: part.input as Record<string, unknown>,
              },
            }))
        : [];

    return {
      role: mappedRole,
      content,
      ...(images.length > 0 ? { images } : {}),
      ...(assistantToolCalls.length > 0
        ? { tool_calls: assistantToolCalls }
        : {}),
    };
  }

  private mapMessageRole(
    role: vscode.LanguageModelChatMessageRole,
  ): LlmMessage["role"] {
    // LanguageModelChatMessageRole is a numeric enum:
    //   User = 1, Assistant = 2
    // There is NO System or Tool role in the VS Code API.
    // Previous code used String(role).toLowerCase() which produced "1"/"2"
    // and never matched "assistant"/"system" — mapping everything to "user".
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
      return "assistant";
    }
    return "user";
  }

  private sanitizeCopilotPreambleMessage(
    content: string,
    stripRefusalDirective: boolean,
    stripStyleDirective: boolean,
    compactCopilotPreamble: boolean,
  ): string {
    if (!this.looksLikeCopilotPreamble(content)) {
      return content;
    }

    let result = compactCopilotPreamble
      ? this.compactCopilotPreambleContent(content)
      : content;

    if (stripRefusalDirective) {
      result = result.replace(
        /\n?If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can't assist with that\."\s*/gi,
        "\n",
      );
    }

    if (stripStyleDirective) {
      result = result.replace(
        /\n?Keep your answers short and impersonal\.\s*/gi,
        "\n",
      );
    }

    result = result.replace(
      /\n?When asked for your name, you must respond with "GitHub Copilot"\.\s*/gi,
      "\n",
    );
    result = result.replace(
      /\n?When asked about the model you are using, you must state that you are using [^\n]+\.?\s*/gi,
      "\n",
    );
    result = result.replace(
      /\n?Follow Microsoft content policies\.\s*/gi,
      "\n",
    );
    result = result.replace(
      /\n?Avoid content that violates copyrights\.\s*/gi,
      "\n",
    );

    return result.replace(/\n{3,}/g, "\n\n").trim();
  }

  private compactEnvelopeUserMessage(content: string): string {
    const extractedUserRequest = this.extractTaggedSection(
      content,
      "userRequest",
    );
    if (extractedUserRequest) {
      return extractedUserRequest;
    }

    return content;
  }

  private extractTaggedSection(content: string, tag: string): string {
    const expression = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
    const matches = Array.from(content.matchAll(expression));
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const value = matches[index]?.[1]?.trim();
      if (value) {
        return value;
      }
    }
    return "";
  }

  private compactCopilotPreambleContent(content: string): string {
    let result = content;

    const removableBlocks = [
      "toolUseInstructions",
      "editFileInstructions",
      "notebookInstructions",
      "outputFormatting",
    ];

    for (const tag of removableBlocks) {
      const expression = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi");
      result = result.replace(expression, "");
    }

    result = result.replace(
      /<instructions>[\s\S]*?<agents>[\s\S]*?<\/agents>[\s\S]*?<\/instructions>/gi,
      "",
    );

    return result.replace(/\n{3,}/g, "\n\n").trim();
  }

  private looksLikeCopilotPreamble(content: string): boolean {
    const normalized = content.toLowerCase();
    return (
      normalized.includes(
        "you are an expert ai programming assistant, working with a user in the vs code editor",
      ) && normalized.includes("follow microsoft content policies")
    );
  }

  private extractImageBase64(part: unknown): string | undefined {
    if (!part || typeof part !== "object") {
      return undefined;
    }

    const candidate = part as {
      mimeType?: unknown;
      data?: unknown;
      value?: unknown;
    };

    const mimeType =
      typeof candidate.mimeType === "string" ? candidate.mimeType : undefined;
    if (!mimeType || !mimeType.startsWith("image/")) {
      return undefined;
    }

    const payload = candidate.data ?? candidate.value;
    if (!payload) {
      return undefined;
    }

    return this.toBase64(payload);
  }

  private toBase64(payload: unknown): string | undefined {
    if (payload instanceof Uint8Array) {
      return Buffer.from(payload).toString("base64");
    }

    if (payload instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(payload)).toString("base64");
    }

    if (
      Array.isArray(payload) &&
      payload.every((entry) => typeof entry === "number")
    ) {
      return Buffer.from(payload).toString("base64");
    }

    if (
      payload &&
      typeof payload === "object" &&
      "type" in payload &&
      (payload as { type?: unknown }).type === "Buffer" &&
      "data" in payload &&
      Array.isArray((payload as { data?: unknown }).data)
    ) {
      return Buffer.from((payload as { data: number[] }).data).toString(
        "base64",
      );
    }

    return undefined;
  }

  private partToText(part: unknown): string {
    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      const result = part.content
        .map((resultPart) =>
          resultPart instanceof vscode.LanguageModelTextPart
            ? resultPart.value
            : "",
        )
        .filter((entry) => entry.length > 0)
        .join("\n");

      if (!result) {
        return "";
      }

      return result;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return "";
    }

    if (typeof part === "string") {
      return part;
    }

    if (part && typeof part === "object" && "value" in part) {
      const value = (part as { value?: unknown }).value;
      if (typeof value === "string") {
        return value;
      }
    }

    return "";
  }

  private parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
    const raw = toolCall.function.arguments;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return raw ?? {};
  }

  private shouldRetryWithoutTools(
    error: unknown,
    tools: LlmToolSpec[],
  ): boolean {
    if (tools.length === 0 || !(error instanceof Error)) {
      return false;
    }

    return /does not support tools/i.test(error.message);
  }

  private createAbortController(
    token: vscode.CancellationToken,
  ): AbortController {
    const abortController = new AbortController();
    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      token.onCancellationRequested(() => abortController.abort());
    }
    return abortController;
  }

  private async acquireChatSlot(
    maxConcurrentRequests: number,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const waitStartedAt = Date.now();

    while (this.activeChatRequests >= maxConcurrentRequests) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      if (Date.now() - waitStartedAt > 30000) {
        this.output.appendLine(
          `[local-qwen] slot wait exceeded 30s (active=${this.activeChatRequests}, max=${maxConcurrentRequests}); forcing slot recovery.`,
        );
        this.activeChatRequests = 0;
        while (this.chatWaiters.length > 0) {
          this.chatWaiters.shift()?.();
        }
        break;
      }

      await new Promise<void>((resolve, reject) => {
        let releaseWaiter: (() => void) | undefined;

        const disposeCancellation = token.onCancellationRequested(() => {
          const index = releaseWaiter
            ? this.chatWaiters.indexOf(releaseWaiter)
            : -1;
          if (index >= 0) {
            this.chatWaiters.splice(index, 1);
          }
          disposeCancellation.dispose();
          reject(new vscode.CancellationError());
        });

        releaseWaiter = () => {
          disposeCancellation.dispose();
          resolve();
        };

        this.chatWaiters.push(releaseWaiter);
      });
    }

    this.activeChatRequests += 1;
    this.output.appendLine(
      `[local-qwen] acquired chat slot (active=${this.activeChatRequests}/${maxConcurrentRequests})`,
    );
  }

  private releaseChatSlot(): void {
    this.activeChatRequests = Math.max(0, this.activeChatRequests - 1);
    this.output.appendLine(
      `[local-qwen] released chat slot (active=${this.activeChatRequests})`,
    );
    const waiter = this.chatWaiters.shift();
    waiter?.();
  }

  private nextCallId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
