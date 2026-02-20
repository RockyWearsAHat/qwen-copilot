import * as vscode from "vscode";
import {
  ChatRequest,
  LlmMessage,
  LlmToolSpec,
  OllamaClient,
  ToolCall,
} from "./ollamaClient";

type ToolSchemaMode = "full" | "compact" | "names-only";

interface LocalLanguageModelInfo extends vscode.LanguageModelChatInformation {
  ollamaName: string;
}

export class LocalLanguageModelProvider implements vscode.LanguageModelChatProvider<LocalLanguageModelInfo> {
  private static readonly toolCallStart = "<local_qwen_tool_call>";
  private static readonly toolCallEnd = "</local_qwen_tool_call>";

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
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const endpoint = configuration.get<string>(
      "endpoint",
      "http://localhost:11434",
    );
    const fallbackModel = configuration.get<string>("model", "qwen2.5:32b");

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
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const endpoint = configuration.get<string>(
      "endpoint",
      "http://localhost:11434",
    );
    const fallbackModel = configuration.get<string>("model", "qwen2.5:32b");

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

  public async provideLanguageModelChatResponse(
    model: LocalLanguageModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const endpoint = configuration.get<string>(
      "endpoint",
      "http://localhost:11434",
    );
    const temperature = configuration.get<number>("temperature", 0.2);
    const timeoutMs = configuration.get<number>("requestTimeoutMs", 120000);
    const maxOutputTokens = configuration.get<number>("maxOutputTokens", 0);
    const contextWindowTokens = configuration.get<number>(
      "contextWindowTokens",
      0,
    );
    const maxConcurrentRequests = configuration.get<number>(
      "maxConcurrentRequests",
      1,
    );
    const maxRequestMessages = configuration.get<number>(
      "maxRequestMessages",
      0,
    );
    const maxRequestChars = configuration.get<number>("maxRequestChars", 0);
    const maxToolsPerRequest = configuration.get<number>(
      "maxToolsPerRequest",
      0,
    );
    const toolSchemaMode = configuration.get<ToolSchemaMode>(
      "toolSchemaMode",
      "compact",
    );
    const toolCallBridgeMode = configuration.get<string>(
      "toolCallBridgeMode",
      "native-then-delimited",
    );
    const logRequestStats = configuration.get<boolean>("logRequestStats", true);

    const abortController = this.createAbortController(token);

    const convertedMessages = messages.map((message) =>
      this.convertRequestMessage(message),
    );
    const shapedMessages = this.shapeMessages(
      convertedMessages,
      maxRequestMessages,
      maxRequestChars,
    );
    const allTools = this.toOllamaToolSpecs(
      options.tools ?? [],
      toolSchemaMode,
    );
    const shapedTools = this.shapeTools(allTools, maxToolsPerRequest);
    const useDelimitedBridge = toolCallBridgeMode === "delimited";
    const requestMessages = useDelimitedBridge
      ? this.withDelimitedToolBridge(shapedMessages, shapedTools)
      : shapedMessages;
    const requestTools = useDelimitedBridge ? [] : shapedTools;

    if (convertedMessages.length !== shapedMessages.length) {
      this.output.appendLine(
        `[local-qwen] reduced request history from ${convertedMessages.length} to ${shapedMessages.length} message(s).`,
      );
    }

    if (allTools.length !== shapedTools.length) {
      this.output.appendLine(
        `[local-qwen] reduced tool specs from ${allTools.length} to ${shapedTools.length}.`,
      );
    }

    const request: ChatRequest = {
      endpoint,
      model: model.ollamaName || model.id,
      temperature,
      maxOutputTokens,
      contextWindowTokens,
      messages: requestMessages,
      tools: requestTools,
    };

    if (logRequestStats) {
      const messageChars = requestMessages.reduce(
        (sum, message) => sum + this.estimateMessageSize(message),
        0,
      );
      const toolChars = JSON.stringify(requestTools).length;
      const approxPromptTokens = Math.ceil((messageChars + toolChars) / 4);
      this.output.appendLine(
        `[local-qwen] request stats: messages=${requestMessages.length}, tools=${requestTools.length}, approxPromptTokens=${approxPromptTokens}, messageChars=${messageChars}, toolChars=${toolChars}, bridge=${toolCallBridgeMode}, num_ctx=${contextWindowTokens > 0 ? contextWindowTokens : "model-default"}, num_predict=${maxOutputTokens > 0 ? maxOutputTokens : "model-default"}`,
      );
    }

    await this.acquireChatSlot(Math.max(1, maxConcurrentRequests), token);

    let result;
    let usedDelimitedBridge = useDelimitedBridge;
    try {
      result = await this.client.chat(
        request,
        abortController.signal,
        timeoutMs,
      );
    } catch (error) {
      if (!this.shouldRetryWithoutTools(error, request.tools)) {
        throw error;
      }

      if (toolCallBridgeMode === "native") {
        this.output.appendLine(
          `[local-qwen] model '${request.model}' does not support native tools and bridge mode is 'native'.`,
        );
        throw error;
      }

      usedDelimitedBridge = true;
      this.output.appendLine(
        `[local-qwen] model '${request.model}' does not support native tools; retrying with delimiter-based tool bridge.`,
      );

      result = await this.client.chat(
        {
          ...request,
          tools: [],
          messages: this.withDelimitedToolBridge(shapedMessages, shapedTools),
        },
        abortController.signal,
        timeoutMs,
      );
    } finally {
      this.releaseChatSlot();
    }

    const nativeToolCalls = result.message.tool_calls ?? [];
    let finalContent = result.message.content ?? "";
    const delimiterParse = this.extractDelimitedToolCalls(finalContent);

    if (delimiterParse.toolCalls.length > 0) {
      finalContent = delimiterParse.cleanedContent;
      if (usedDelimitedBridge) {
        this.output.appendLine(
          `[local-qwen] parsed ${delimiterParse.toolCalls.length} delimiter tool call(s).`,
        );
      }
    }

    const toolCalls =
      nativeToolCalls.length > 0 ? nativeToolCalls : delimiterParse.toolCalls;

    for (const toolCall of toolCalls) {
      const toolInput = this.parseToolArgs(toolCall);
      progress.report(
        new vscode.LanguageModelToolCallPart(
          toolCall.id ?? this.nextCallId(),
          toolCall.function.name,
          toolInput,
        ),
      );
    }

    if (finalContent.trim().length > 0) {
      progress.report(new vscode.LanguageModelTextPart(finalContent));
    }
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
    return {
      id: model,
      name: model,
      family: this.inferFamily(model),
      version: "local",
      detail: "configured default",
      tooltip: `Local Ollama model: ${model}`,
      maxInputTokens: 32768,
      maxOutputTokens: 8192,
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
    const modelListTimeoutMs = vscode.workspace
      .getConfiguration("localQwen")
      .get<number>("modelListTimeoutMs", 7000);

    const ttlMs = vscode.workspace
      .getConfiguration("localQwen")
      .get<number>("modelListCacheTtlMs", 10000);

    const controller = new AbortController();

    try {
      const models = await this.client.listModels(
        endpoint,
        controller.signal,
        modelListTimeoutMs,
      );

      const infos =
        models.length === 0
          ? [this.createFallbackInfo(fallbackModel)]
          : models.map((model) => {
              const id = model.model ?? model.name;
              const family =
                model.details?.family ?? this.inferFamily(model.name);
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
                maxInputTokens: 32768,
                maxOutputTokens: 8192,
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

  private toOllamaToolSpecs(
    tools: readonly vscode.LanguageModelChatTool[],
    schemaMode: ToolSchemaMode,
  ): LlmToolSpec[] {
    return tools.map((tool) => {
      const defaultParams: Record<string, unknown> = {
        type: "object",
        additionalProperties: true,
      };

      if (schemaMode === "names-only") {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: "",
            parameters: defaultParams,
          },
        };
      }

      if (schemaMode === "compact") {
        const compactDescription = (tool.description ?? "").slice(0, 160);
        return {
          type: "function",
          function: {
            name: tool.name,
            description: compactDescription,
            parameters: defaultParams,
          },
        };
      }

      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: (tool.inputSchema ?? defaultParams) as Record<
            string,
            unknown
          >,
        },
      };
    });
  }

  private shapeMessages(
    messages: LlmMessage[],
    maxMessages: number,
    maxChars: number,
  ): LlmMessage[] {
    if (maxMessages <= 0 && maxChars <= 0) {
      return messages;
    }

    const safeMaxMessages = Math.max(1, maxMessages);
    const safeMaxChars =
      maxChars > 0 ? Math.max(500, maxChars) : Number.MAX_SAFE_INTEGER;

    const tail = messages.slice(-safeMaxMessages);
    const selected: LlmMessage[] = [];
    let runningChars = 0;

    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const message = tail[index];
      const messageChars = this.estimateMessageSize(message);
      if (selected.length > 0 && runningChars + messageChars > safeMaxChars) {
        break;
      }

      selected.push(message);
      runningChars += messageChars;

      if (runningChars >= safeMaxChars) {
        break;
      }
    }

    return selected.reverse();
  }

  private shapeTools(
    tools: LlmToolSpec[],
    maxToolsPerRequest: number,
  ): LlmToolSpec[] {
    if (maxToolsPerRequest <= 0) {
      return tools;
    }

    const safeMax = Math.max(1, maxToolsPerRequest);

    return tools.slice(0, safeMax);
  }

  private withDelimitedToolBridge(
    messages: LlmMessage[],
    tools: LlmToolSpec[],
  ): LlmMessage[] {
    if (tools.length === 0) {
      return messages;
    }

    const catalog = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));

    const instruction = [
      "Tool-call bridge mode is active.",
      `When you need a tool, output ONLY this exact wrapper: ${LocalLanguageModelProvider.toolCallStart}{\"name\":\"tool_name\",\"arguments\":{...}}${LocalLanguageModelProvider.toolCallEnd}`,
      "You may emit multiple wrapped tool calls.",
      "Do not include markdown fences around the wrapper.",
      `Available tools: ${JSON.stringify(catalog)}`,
    ].join("\n");

    return [
      {
        role: "system",
        content: instruction,
      },
      ...messages,
    ];
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

  private estimateMessageSize(message: LlmMessage): number {
    const contentSize = message.content.length;
    const toolCallSize = JSON.stringify(message.tool_calls ?? []).length;
    const imageSize = (message.images?.length ?? 0) * 500;
    return contentSize + toolCallSize + imageSize + 24;
  }

  private convertRequestMessage(
    message: vscode.LanguageModelChatRequestMessage,
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

    const content = textSegments.join("\n").trim();

    const mappedRole = this.mapMessageRole(message.role);

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
    const normalized = String(role).toLowerCase();
    if (normalized.includes("assistant")) {
      return "assistant";
    }

    if (normalized.includes("system")) {
      return "system";
    }

    if (normalized.includes("tool")) {
      return "tool";
    }

    return "user";
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
    while (this.activeChatRequests >= maxConcurrentRequests) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
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
  }

  private releaseChatSlot(): void {
    this.activeChatRequests = Math.max(0, this.activeChatRequests - 1);
    const waiter = this.chatWaiters.shift();
    waiter?.();
  }

  private nextCallId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
