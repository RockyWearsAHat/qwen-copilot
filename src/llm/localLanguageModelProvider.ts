import * as vscode from "vscode";
import {
  ChatRequest,
  LlmMessage,
  LlmToolSpec,
  OllamaClient,
  ToolCall,
} from "./ollamaClient";

interface LocalLanguageModelInfo extends vscode.LanguageModelChatInformation {
  ollamaName: string;
}

export class LocalLanguageModelProvider implements vscode.LanguageModelChatProvider<LocalLanguageModelInfo> {
  private readonly client = new OllamaClient();

  public constructor(private readonly output: vscode.OutputChannel) {}

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

    const abortController = this.createAbortController(token);

    try {
      const models = await this.client.listModels(
        endpoint,
        abortController.signal,
      );
      if (models.length === 0) {
        return [this.createFallbackInfo(fallbackModel)];
      }

      return models.map((model) => {
        const id = model.model ?? model.name;
        const family = model.details?.family ?? this.inferFamily(model.name);
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
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[local-qwen] model listing failed: ${text}`);
      return [this.createFallbackInfo(fallbackModel)];
    }
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

    const abortController = this.createAbortController(token);

    const request: ChatRequest = {
      endpoint,
      model: model.ollamaName || model.id,
      temperature,
      messages: messages.map((message) => this.convertRequestMessage(message)),
      tools: this.toOllamaToolSpecs(options.tools ?? []),
    };

    let result;
    try {
      result = await this.client.chat(request, abortController.signal);
    } catch (error) {
      if (!this.shouldRetryWithoutTools(error, request.tools)) {
        throw error;
      }

      this.output.appendLine(
        `[local-qwen] model '${request.model}' does not support tools; retrying without tool definitions.`,
      );

      result = await this.client.chat(
        {
          ...request,
          tools: [],
        },
        abortController.signal,
      );
    }

    for (const toolCall of result.message.tool_calls ?? []) {
      const toolInput = this.parseToolArgs(toolCall);
      progress.report(
        new vscode.LanguageModelToolCallPart(
          toolCall.id ?? this.nextCallId(),
          toolCall.function.name,
          toolInput,
        ),
      );
    }

    if (result.message.content) {
      progress.report(new vscode.LanguageModelTextPart(result.message.content));
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
  ): LlmToolSpec[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? {
          type: "object",
          additionalProperties: true,
        }) as Record<string, unknown>,
      },
    }));
  }

  private convertRequestMessage(
    message: vscode.LanguageModelChatRequestMessage,
  ): LlmMessage {
    const content = message.content
      .map((part) => this.partToText(part))
      .join("\n")
      .trim();

    const assistantToolCalls =
      message.role === vscode.LanguageModelChatMessageRole.Assistant
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
      role:
        message.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "user",
      content,
      ...(assistantToolCalls.length > 0
        ? { tool_calls: assistantToolCalls }
        : {}),
    };
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

      return `tool_result(${part.callId}): ${result}`;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return `tool_call(${part.callId}): ${part.name} ${JSON.stringify(part.input)}`;
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

  private nextCallId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
