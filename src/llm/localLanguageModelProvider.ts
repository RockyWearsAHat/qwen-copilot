import * as vscode from "vscode";
import {
  ChatRequest,
  LlmMessage,
  LlmToolSpec,
  ModelCapabilities,
  OllamaModelInfo,
  OllamaClient,
  ToolCall,
  inferCapabilitiesFromName,
} from "./ollamaClient";
import { prepareMessagesWithVision } from "./ollamaVision";
import { streamResponseNativeOnly } from "./provider/streaming/streamResponseNativeOnly";
import { buildSystemPrompt } from "./provider/prompt/systemPrompt";
import { buildWorkspaceContextSnapshot } from "./provider/context/snapshots";
import { ToolSpecBuilder } from "./provider/tools/toolSpecBuilder";
import { MessageConverter } from "./provider/message/messageConverter";
import { ModelRegistry, LocalLanguageModelInfo } from "./provider/model/modelRegistry";
import { appendOutboundOllamaRequestLog } from "./provider/debug/outboundLogger";
import { nextCallId } from "./provider/utils/coercion";

type PerformanceProfileName = "quality" | "balanced" | "fast";

interface PerformanceProfile {
  name: PerformanceProfileName;
  maxInitialTools: number;
  maxRequestMessages: number;
  maxRequestContentChars: number;
  maxLatestUserChars: number;
  maxPreambleChars: number;
  maxIntermediateMessageChars: number;
  minDynamicContextTokens: number;
  maxDynamicContextTokens: number;
  defaultMaxOutputTokens: number;
  toolFirstMaxOutputTokens: number;
  maxToolDescriptionChars: number;
}

export class LocalLanguageModelProvider implements vscode.LanguageModelChatProvider<LocalLanguageModelInfo> {
  private static readonly defaultContextLength = 32768;
  private static readonly defaultEndpoint = "http://localhost:11434";
  private static readonly defaultModel = "qwen2.5:32b";
  private static readonly defaultTemperature = 0.2;

  // 80 % of the context window is used for input tokens.  Copilot Chat and
  // other VS Code LM consumers prune context down to maxInputTokens before
  // sending the request, so an overly small ratio causes aggressive pruning and
  // severely degrades agent performance.  0.80 leaves 20 % headroom for
  // generation while keeping the full context available for reading.
  private static readonly inputBudgetRatio = 0.8;

  private static readonly toolTurnMaxOutputTokens = 4096;

  private static readonly runtimeVerificationToolNames = [
    // Generic machine-interaction tool names (when provided by host/runtime)
    "take_screenshot",
    "analyze_image",
    "ocr_find_text",
    "list_windows",
    "focus_window",
    "launch_app",
    "gui_click",
    "gui_type",
    "gui_key",
    "gui_key_hold",
    "gui_scroll",
    "wait_for_condition",
    // Local extension-prefixed aliases registered by this extension
    "localQwen_take_screenshot",
    "localQwen_analyze_image",
    "localQwen_ocr_find_text",
    "localQwen_list_windows",
    "localQwen_focus_window",
    "localQwen_launch_app",
    "localQwen_gui_click",
    "localQwen_gui_type",
    "localQwen_gui_key",
    "localQwen_gui_key_hold",
    "localQwen_gui_scroll",
    "localQwen_wait_for_condition",
  ] as const;

  private static readonly workspaceSnapshotCacheTtlMs = 60000;

  private static readonly performanceProfiles: Record<PerformanceProfileName, PerformanceProfile> =
    {
      quality: {
        name: "quality",
        maxInitialTools: 18,
        maxRequestMessages: 18,
        maxRequestContentChars: 90000,
        maxLatestUserChars: 24000,
        maxPreambleChars: 15000,
        maxIntermediateMessageChars: 9000,
        minDynamicContextTokens: 32768,
        maxDynamicContextTokens: 262144,
        defaultMaxOutputTokens: 4096,
        toolFirstMaxOutputTokens: 1536,
        maxToolDescriptionChars: 320,
      },
      balanced: {
        name: "balanced",
        maxInitialTools: 20,
        maxRequestMessages: 20,
        maxRequestContentChars: 95000,
        maxLatestUserChars: 28000,
        maxPreambleChars: 18000,
        maxIntermediateMessageChars: 10000,
        minDynamicContextTokens: 24576,
        maxDynamicContextTokens: 131072,
        defaultMaxOutputTokens: 3072,
        toolFirstMaxOutputTokens: 1280,
        maxToolDescriptionChars: 320,
      },
      fast: {
        name: "fast",
        maxInitialTools: 8,
        maxRequestMessages: 10,
        maxRequestContentChars: 35000,
        maxLatestUserChars: 11000,
        maxPreambleChars: 8000,
        maxIntermediateMessageChars: 4000,
        minDynamicContextTokens: 16384,
        maxDynamicContextTokens: 65536,
        defaultMaxOutputTokens: 2048,
        toolFirstMaxOutputTokens: 1024,
        maxToolDescriptionChars: 140,
      },
    };

  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
  private readonly client = new OllamaClient();

  private readonly modelRegistry: ModelRegistry;
  private readonly messageConverter: MessageConverter;

  private cachedModelInfos?: {
    expiresAt: number;
    infos: LocalLanguageModelInfo[];
  };
  private inFlightModelInfoRequest?: Promise<LocalLanguageModelInfo[]>;
  private activeChatRequests = 0;
  private readonly chatWaiters: Array<() => void> = [];

  private toolSpecBuilder = new ToolSpecBuilder();
  private cachedWorkspaceSnapshot?: { expiresAt: number; value: string };
  private readonly workspaceFileWatcher: vscode.FileSystemWatcher;
  /** Per-model capabilities cache — avoids repeated /api/show calls in the same session. */
  private readonly modelCapabilitiesCache = new Map<string, ModelCapabilities>();

  public constructor(private readonly output: vscode.OutputChannel) {
    this.modelRegistry = new ModelRegistry(this.client, this.output);
    this.messageConverter = new MessageConverter(this.output);

    // Immediately invalidate the workspace snapshot cache whenever files are
    // created, deleted, or renamed so the next request always sees current state.
    this.workspaceFileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    const bust = () => {
      this.cachedWorkspaceSnapshot = undefined;
    };
    this.workspaceFileWatcher.onDidCreate(bust);
    this.workspaceFileWatcher.onDidDelete(bust);
  }

  // ---------------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------------

  public async warmModelInfos(): Promise<void> {
    const endpoint = LocalLanguageModelProvider.defaultEndpoint;
    const fallbackModel = LocalLanguageModelProvider.defaultModel;

    try {
      await this.fetchModelInfos(endpoint, fallbackModel);
      this.modelInfoChangedEmitter.fire();
    } catch {
      this.modelInfoChangedEmitter.fire();
    }
  }

  public invalidateModelInfos(): void {
    this.cachedModelInfos = undefined;
    this.inFlightModelInfoRequest = undefined;
  }

  public dispose(): void {
    this.modelInfoChangedEmitter.dispose();
    this.workspaceFileWatcher.dispose();
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
      this.inFlightModelInfoRequest = this.fetchModelInfos(endpoint, fallbackModel).finally(() => {
        this.inFlightModelInfoRequest = undefined;
      });
    }

    return this.inFlightModelInfoRequest;
  }

  // ---------------------------------------------------------------------------
  // Main request handler — thin translation layer
  // ---------------------------------------------------------------------------

  public async provideLanguageModelChatResponse(
    model: LocalLanguageModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const performanceProfile = this.getPerformanceProfile();
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const compactCopilotPreamble = configuration.get<boolean>("compactCopilotPreamble", true);
    const sanitizeCopilotPreamble = configuration.get<boolean>("sanitizeCopilotPreamble", true);
    const promptMode = configuration.get<string>("promptMode", "guided").trim().toLowerCase();
    const enableWorkspaceSnapshot = configuration.get<boolean>("enableWorkspaceSnapshot", true);

    const toolsPolicy = configuration.get<string>("toolsPolicy", "enabled").trim().toLowerCase();
    const toolsDisabled = toolsPolicy === "disabled";

    const endpoint = LocalLanguageModelProvider.defaultEndpoint;
    const temperature = LocalLanguageModelProvider.defaultTemperature;
    const timeoutMs = 0;

    const modelContextWindowTokens = model.maxInputTokens + model.maxOutputTokens;
    let contextWindowTokens = modelContextWindowTokens;
    let maxOutputTokens = Math.min(
      model.maxOutputTokens,
      performanceProfile.defaultMaxOutputTokens,
    );

    const abortController = this.createAbortController(token);

    await this.acquireChatSlot(1, token);

    try {
      // 1. Convert messages
      let convertedMessages = this.messageConverter.convertRequestMessages(messages, true);

      // 2. Optionally sanitize Copilot preamble
      if (sanitizeCopilotPreamble && convertedMessages.length > 0) {
        const firstMessage = convertedMessages[0];
        const sanitizedFirst = this.messageConverter.sanitizeCopilotPreambleMessage(
          firstMessage.content,
          true,
          true,
          compactCopilotPreamble,
        );

        if (sanitizedFirst !== firstMessage.content) {
          firstMessage.content = sanitizedFirst;
          this.output.appendLine(
            "[local-qwen] sanitized Copilot preamble while preserving tool instructions.",
          );
        }
      }

      // 3. Debug dump of converted messages
      if (this.isDebugDumpEnabled() && convertedMessages.length > 0) {
        const debugPayload = convertedMessages
          .map((message, index) => {
            const header = `--- message[${index}] role=${message.role} ---`;
            return `${header}\n${message.content}`;
          })
          .join("\n\n");
        this.writeDebugDump(
          "/tmp/copilot-system-prompt-debug.txt",
          debugPayload,
          `wrote ${convertedMessages.length} outbound messages`,
        );
      }

      // 4. Convert ALL tools (no subsetting!)
      let tools: LlmToolSpec[] = toolsDisabled
        ? []
        : this.toOllamaToolSpecs(options.tools ?? [], performanceProfile, true, false);

      if (!toolsDisabled) {
        tools = this.withInjectedRuntimeVerificationTools(tools);
      }

      // 5. Cap output tokens when tools are provided
      if (tools.length > 0) {
        maxOutputTokens = Math.min(
          maxOutputTokens,
          LocalLanguageModelProvider.toolTurnMaxOutputTokens,
        );
      }

      // 6. Inject system prompt
      if (promptMode !== "none" && tools.length > 0) {
        const lockedIntent = this.extractLockedIntentFromRawMessages(messages);
        convertedMessages = [
          {
            role: "system",
            content: buildSystemPrompt({
              isPackageManagement: this.isExplicitPackageManagementRequest(lockedIntent),
              lockedIntent,
              enablePlanningAndChecklists: true,
            }),
          },
          ...convertedMessages,
        ];
      }

      // 7. Optionally inject workspace snapshot
      if (enableWorkspaceSnapshot) {
        const snapshot = await this.getWorkspaceContextSnapshotCached();
        if (snapshot) {
          // Prepend the snapshot to the LAST user message so the file tree
          // and open editor contents are in the highest-attention zone.
          // Many local models deprioritize mid-conversation system messages,
          // but always fully attend to the user turn they are responding to.
          const lastUserIdx = convertedMessages.reduce(
            (last, msg, idx) => (msg.role === "user" ? idx : last),
            -1,
          );
          if (lastUserIdx >= 0) {
            const lastUser = convertedMessages[lastUserIdx];
            convertedMessages = [
              ...convertedMessages.slice(0, lastUserIdx),
              { role: "user", content: snapshot + "\n\n" + lastUser.content },
              ...convertedMessages.slice(lastUserIdx + 1),
            ];
          } else {
            // Fallback: append as a user message
            convertedMessages.push({ role: "user", content: snapshot });
          }
        }
      }

      // 7.5. Detect "identical" replacement results — inject a stale-error reminder
      // When replace_string_in_file returns "identical", the model should stop
      // investigating but often continues. Inject an explicit system nudge.
      {
        const lastToolIdx = convertedMessages.reduce(
          (last, msg, idx) => (msg.role === "tool" ? idx : last),
          -1,
        );
        if (lastToolIdx >= 0) {
          const lastToolMsg = convertedMessages[lastToolIdx];
          const content = typeof lastToolMsg.content === "string" ? lastToolMsg.content : "";
          if (
            content.includes("identical") &&
            (lastToolMsg.tool_name === "replace_string_in_file" ||
              content.includes("Input and output are identical"))
          ) {
            // Insert a system message right after the tool result
            convertedMessages = [
              ...convertedMessages.slice(0, lastToolIdx + 1),
              {
                role: "system" as const,
                content:
                  '⚠️ STOP: replace_string_in_file returned "identical" — the code ALREADY has the correct value. ' +
                  "The error is STALE. Do NOT call any more tools. Respond now: tell the user the code is already correct " +
                  "and the error is from a previous state.",
              },
              ...convertedMessages.slice(lastToolIdx + 1),
            ];
          }
        }
      }

      // 8. Vision
      const modelName = model.ollamaName || model.id;
      const modelCapabilities = await this.resolveModelCapabilities(
        modelName,
        endpoint,
        abortController.signal,
      );

      const configuredVisionModel = configuration.get<string>("visionModel", "").trim();
      convertedMessages = await prepareMessagesWithVision(
        convertedMessages,
        modelName,
        endpoint,
        this.output,
        modelCapabilities.supportsVision,
        configuredVisionModel,
      );

      // 9. Compute dynamic context window
      const messageChars = convertedMessages.reduce(
        (sum, message) => sum + this.estimateMessageSize(message),
        0,
      );
      const toolChars = JSON.stringify(tools).length;
      const approxPromptTokens = Math.ceil((messageChars + toolChars) / 4);
      contextWindowTokens = this.computeDynamicContextWindowTokens(
        modelContextWindowTokens,
        approxPromptTokens,
        performanceProfile,
        maxOutputTokens,
      );

      // 10. Build request
      const request: ChatRequest = {
        endpoint,
        model: modelName,
        temperature,
        maxOutputTokens,
        contextWindowTokens,
        keepAlive: "30m",
        messages: convertedMessages,
        tools,
        ...(modelCapabilities.supportsThinking ? { think: true } : {}),
      };

      // 11. Log outbound request
      void appendOutboundOllamaRequestLog({
        output: this.output,
        source: "lm-provider",
        request: {
          endpoint: request.endpoint,
          model: request.model,
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          contextWindowTokens: request.contextWindowTokens,
          messages: request.messages,
          tools: request.tools,
          think: (request as { think?: boolean }).think,
        },
      });

      if (this.isDebugDumpEnabled()) {
        this.writeDebugDump(
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
          `wrote full request payload (tools=${request.tools.length})`,
        );
      }

      this.output.appendLine(
        `[local-qwen] request(profile=${performanceProfile.name}): messages=${convertedMessages.length}, tools=${tools.length}, ~${approxPromptTokens} prompt tokens, modelMaxInput=${model.maxInputTokens}, num_ctx=${contextWindowTokens}, num_predict=${maxOutputTokens}`,
      );

      // 12. Stream response — NO blocking, NO retry
      await this.streamResponse(request, abortController, timeoutMs, progress);
    } finally {
      this.releaseChatSlot();
    }
  }

  // ---------------------------------------------------------------------------
  // Token counting
  // ---------------------------------------------------------------------------

  public async provideTokenCount(
    _model: LocalLanguageModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const raw =
      typeof text === "string" ? text : text.content.map((part) => this.partToText(part)).join(" ");
    return Math.max(1, Math.ceil(raw.length / 4));
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  /**
   * Stream from Ollama and report text/tool-call parts to Copilot.
   * Thin wrapper around streamResponseNativeOnly with no blocking callbacks.
   */
  private async streamResponse(
    request: ChatRequest,
    abortController: AbortController,
    timeoutMs: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<{
    emittedToolCalls: boolean;
    fullContentLength: number;
    usedToolNames: string[];
  }> {
    return streamResponseNativeOnly({
      request,
      client: this.client,
      output: this.output,
      abortController,
      timeoutMs,
      progress,
      streamTextDeltas: true,
      emitTextWhenNoToolCall: true,
      callbacks: {
        parseToolArgs: (toolCall) => this.parseToolArgs(toolCall),
        nextCallId: () => nextCallId(),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Model capabilities
  // ---------------------------------------------------------------------------

  /**
   * Fetch and cache what capabilities a model supports (thinking, vision).
   * Uses Ollama's `/api/show` capabilities array; falls back to name heuristics.
   * Results are cached for the session lifetime so repeated requests are free.
   */
  private async resolveModelCapabilities(
    modelName: string,
    endpoint: string,
    abortSignal: AbortSignal,
  ): Promise<ModelCapabilities> {
    const cached = this.modelCapabilitiesCache.get(modelName);
    if (cached !== undefined) {
      return cached;
    }
    let capabilities: ModelCapabilities;
    try {
      capabilities = await this.client.getModelCapabilities(endpoint, modelName, abortSignal);
    } catch {
      // Non-critical — fall through to name heuristic
      capabilities = inferCapabilitiesFromName(modelName);
    }
    this.output.appendLine(
      `[local-qwen] model capabilities: ${modelName} → thinking=${capabilities.supportsThinking}, vision=${capabilities.supportsVision}`,
    );
    this.modelCapabilitiesCache.set(modelName, capabilities);
    return capabilities;
  }

  // ---------------------------------------------------------------------------
  // Model registry delegation
  // ---------------------------------------------------------------------------

  private async fetchModelInfos(
    endpoint: string,
    fallbackModel: string,
  ): Promise<LocalLanguageModelInfo[]> {
    return this.modelRegistry.fetchModelInfos(endpoint, fallbackModel);
  }

  private getCachedModelInfos(): LocalLanguageModelInfo[] | undefined {
    return this.modelRegistry.getCachedModelInfos();
  }

  // ---------------------------------------------------------------------------
  // Tool spec conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert VS Code tool definitions to Ollama-compatible tool specs.
   * Always sends the full schema — Copilot decides which tools to include.
   */
  private toOllamaToolSpecs(
    tools: readonly vscode.LanguageModelChatTool[],
    performanceProfile: PerformanceProfile,
    compactSchema: boolean,
    namesOnly: boolean,
  ): LlmToolSpec[] {
    return this.toolSpecBuilder.toOllamaToolSpecs(
      tools,
      performanceProfile,
      compactSchema,
      namesOnly,
    );
  }

  private withInjectedRuntimeVerificationTools(tools: readonly LlmToolSpec[]): LlmToolSpec[] {
    const existingNames = new Set(
      tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    const registryByName = new Map(vscode.lm.tools.map((tool) => [tool.name, tool] as const));

    const injected = LocalLanguageModelProvider.runtimeVerificationToolNames
      .map((name) => registryByName.get(name))
      .filter(
        (tool): tool is vscode.LanguageModelToolInformation =>
          tool !== undefined && !existingNames.has(tool.name),
      )
      .map(
        (tool) =>
          ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
                type: "object",
                additionalProperties: true,
              },
            },
          }) satisfies LlmToolSpec,
      );

    if (injected.length === 0) {
      return [...tools];
    }

    this.output.appendLine(
      `[local-qwen] injected runtime verification tools: +${injected.length} (${injected
        .map((tool) => tool.function.name)
        .join(", ")})`,
    );

    // Prepend visual/runtime tools so they appear early in the tool list.
    // Models strongly favor tools near the top; placing screenshot/GUI tools
    // first makes the model much more likely to use them for runtime errors.
    return [...injected, ...tools];
  }

  // ---------------------------------------------------------------------------
  // Tool argument parsing (JSON parse + type coercion for local models)
  // ---------------------------------------------------------------------------

  private parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
    const raw = toolCall.function.arguments;
    let parsed: Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.output.appendLine(
          `[local-qwen] WARNING: tool '${toolCall.function.name}' arguments are not valid JSON — raw: ${String(raw).slice(0, 120)}`,
        );
        return {};
      }
    } else {
      parsed = raw ?? {};
    }

    // Local models (especially Qwen/Llama) often emit Python-style string
    // booleans ("True"/"False") or string numbers ("30") instead of proper
    // JSON types. VS Code validates tool inputs against JSON schemas and
    // rejects these with "must be boolean" / "must be number" errors.
    // Coerce common mismatches so the tool calls succeed.
    const coerced = this.coerceToolArgs(parsed);
    if (coerced !== parsed) {
      this.output.appendLine(
        `[local-qwen] coerced tool args for '${toolCall.function.name}' (string→boolean/number fixups applied)`,
      );
    }
    return coerced;
  }

  /**
   * Recursively coerce common type mismatches in tool arguments:
   * - String booleans ("True"/"False"/"true"/"false") → real booleans
   * - String integers/floats ("30", "0.5") → real numbers
   *   (only when the string is purely numeric — not paths, queries, etc.)
   */
  private coerceToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower === "true") {
          result[key] = true;
          changed = true;
        } else if (lower === "false") {
          result[key] = false;
          changed = true;
        } else if (/^-?\d+$/.test(value) && value.length < 16) {
          // Pure integer string — coerce to number.
          // Length guard prevents mangling large IDs or hashes.
          result[key] = parseInt(value, 10);
          changed = true;
        } else if (/^-?\d+\.\d+$/.test(value) && value.length < 20) {
          result[key] = parseFloat(value);
          changed = true;
        } else {
          result[key] = value;
        }
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const inner = this.coerceToolArgs(value as Record<string, unknown>);
        result[key] = inner;
        if (inner !== value) {
          changed = true;
        }
      } else {
        result[key] = value;
      }
    }
    return changed ? result : args;
  }

  // ---------------------------------------------------------------------------
  // Context window sizing
  // ---------------------------------------------------------------------------

  private computeDynamicContextWindowTokens(
    modelContextWindowTokens: number,
    approxPromptTokens: number,
    performanceProfile: PerformanceProfile,
    maxOutputTokens?: number,
  ): number {
    // CRITICAL: Ollama's num_ctx is the TOTAL context window (input + output).
    // We must ensure num_ctx >= approxPromptTokens + maxOutputTokens, otherwise
    // the model physically cannot generate its full output budget.
    //
    // Strategy: use the larger of:
    //   (a) prompt + output budget (hard floor)
    //   (b) profile minimum
    // Then cap at the lesser of profile max and model max.
    const outputBudget = maxOutputTokens ?? performanceProfile.defaultMaxOutputTokens;
    const hardFloor = approxPromptTokens + outputBudget;
    const bounded = Math.min(
      Math.max(hardFloor, performanceProfile.minDynamicContextTokens),
      performanceProfile.maxDynamicContextTokens,
      modelContextWindowTokens,
    );

    return bounded;
  }

  // ---------------------------------------------------------------------------
  // Workspace snapshot caching
  // ---------------------------------------------------------------------------

  private async getWorkspaceContextSnapshotCached(): Promise<string> {
    const cached = this.cachedWorkspaceSnapshot;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await buildWorkspaceContextSnapshot();
    this.cachedWorkspaceSnapshot = {
      expiresAt: Date.now() + LocalLanguageModelProvider.workspaceSnapshotCacheTtlMs,
      value,
    };
    return value;
  }

  // ---------------------------------------------------------------------------
  // Performance profile
  // ---------------------------------------------------------------------------

  private getPerformanceProfile(): PerformanceProfile {
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const configured = configuration.get<string>("performanceProfile", "balanced");

    if (configured === "quality") {
      return LocalLanguageModelProvider.performanceProfiles.quality;
    }
    if (configured === "fast") {
      return LocalLanguageModelProvider.performanceProfiles.fast;
    }
    return LocalLanguageModelProvider.performanceProfiles.balanced;
  }

  // ---------------------------------------------------------------------------
  // Copilot compatibility mode
  // ---------------------------------------------------------------------------

  private isCopilotCompatibilityMode(): boolean {
    const configuration = vscode.workspace.getConfiguration("localQwen");
    return configuration.get<boolean>("copilotCompatibilityMode", true);
  }

  // ---------------------------------------------------------------------------
  // Debug dump
  // ---------------------------------------------------------------------------

  private isDebugDumpEnabled(): boolean {
    return this.messageConverter.isDebugDumpEnabled();
  }

  private writeDebugDump(filePath: string, payload: string, summary: string): void {
    this.messageConverter.writeDebugDump(filePath, payload, summary);
  }

  // ---------------------------------------------------------------------------
  // Message helpers
  // ---------------------------------------------------------------------------

  private estimateMessageSize(message: LlmMessage): number {
    let size = (message.content ?? "").length;
    if (message.role) {
      size += message.role.length;
    }
    return size;
  }

  private partToText(part: unknown): string {
    return this.messageConverter.partToText(part);
  }

  // ---------------------------------------------------------------------------
  // Intent extraction (simplified — just finds <userRequest> tag content)
  // ---------------------------------------------------------------------------

  /**
   * Extracts the locked intent text directly from the raw VS Code messages,
   * BEFORE message conversion strips the `<userRequest>` envelope tags.
   *
   * This is the only reliable way to get the actual user request text when
   * Copilot wraps messages in an `<userRequest>...</userRequest>` envelope.
   */
  private extractLockedIntentFromRawMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== vscode.LanguageModelChatMessageRole.User) {
        continue;
      }

      // Collect raw text content from all text parts
      const textParts: string[] = [];
      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        }
      }
      const rawContent = textParts.join("\n").trim();
      if (!rawContent) {
        continue;
      }

      const tagged = this.messageConverter.extractTaggedSection(rawContent, "userRequest");
      const candidate = (tagged || rawContent).replace(/\s+/g, " ").trim().slice(0, 3000);

      if (candidate) {
        return candidate;
      }
    }
    return "";
  }

  private extractLatestRawUserText(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== vscode.LanguageModelChatMessageRole.User) {
        continue;
      }
      const textParts: string[] = [];
      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        }
      }
      const raw = textParts.join("\n").trim();
      if (raw) {
        return raw;
      }
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Simple helpers
  // ---------------------------------------------------------------------------

  private isExplicitPackageManagementRequest(text: string): boolean {
    const normalized = text.toLowerCase();
    if (!normalized) {
      return false;
    }

    const mentionsPackageTarget =
      /\b(package\.json|package-lock(?:\.json)?|dependencies|devdependencies|version|vite|typescript|ts-node|npm|pnpm|yarn)\b/i.test(
        normalized,
      );
    const hasChangeVerb =
      /\b(update|upgrade|downgrade|install|remove|add|bump|pin|change|modify|edit)\b/i.test(
        normalized,
      );

    return mentionsPackageTarget && hasChangeVerb;
  }

  // ---------------------------------------------------------------------------
  // Abort controller
  // ---------------------------------------------------------------------------

  private createAbortController(token: vscode.CancellationToken): AbortController {
    const abortController = new AbortController();
    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      token.onCancellationRequested(() => abortController.abort());
    }
    return abortController;
  }

  // ---------------------------------------------------------------------------
  // Chat slot management
  // ---------------------------------------------------------------------------

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
          const index = releaseWaiter ? this.chatWaiters.indexOf(releaseWaiter) : -1;
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
    this.output.appendLine(`[local-qwen] released chat slot (active=${this.activeChatRequests})`);
    const waiter = this.chatWaiters.shift();
    waiter?.();
  }
}
