import * as vscode from "vscode";
import { ChatRequest, LlmMessage, LlmToolSpec, OllamaClient, ToolCall } from "../llm/ollamaClient";
import { ToolRegistry } from "../tools/toolRegistry";
import { extractIntent, maybeRefineIntent, type LockedIntent } from "../intent/intentExtractor";
import { selectTools } from "../tools/toolSelector";
import { SessionTracker } from "./sessionTracker";
import { buildExecutionAnchor } from "../prompt/executionAnchor";
import { runAutonomousLoop } from "./autonomousLoop";
import { prepareMessagesWithVision, type OllamaVisionMessage } from "../llm/ollamaVision";
import { buildWorkspaceContextSnapshot } from "../llm/provider/context/snapshots";
import { appendOutboundOllamaRequestLog } from "../llm/provider/debug/outboundLogger";
import { writeLatestDebugSnapshot } from "../llm/provider/debug/latestSnapshot";
import { renderPromptReferencesContext } from "./promptReferences";

/**
 * Drives a single user request through the full agent loop:
 * intent extraction → tool selection → LLM call →
 * tool execution → verification.
 *
 * Key correctness guarantees:
 *  - A pre-flight planning turn asks the LLM to produce a JSON step-plan
 *    before any tools are called, scaffolding chain-of-thought reasoning.
 *  - The current plan step and set of already-read files are injected into
 *    every execution anchor so the LLM knows exactly what to do next.
 *  - Tool names are snake_case matching the registered handler names.
 *  - Tool selection is workspace-state-aware: discovery tools are forced first
 *    on the initial turn for feature-request and general intents.
 *  - Evidence is preserved in full for the most recent result rather than
 *    being aggressively truncated.
 *  - Zero-mutation turns are tracked; escalation prompt is injected after two
 *    consecutive diagnostic-only turns.
 */
export class LocalAgentRunner {
  private readonly llmClient = new OllamaClient();

  public constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async handleRequest(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const endpoint = configuration.get<string>("endpoint", "http://localhost:11434");
    const model = configuration.get<string>("model", "qwen2.5:32b");
    const visionModel = configuration.get<string>("visionModel", "").trim();
    const maxAgentSteps = configuration.get<number>("maxAgentSteps", 6);
    const temperature = configuration.get<number>("temperature", 0.2);
    const toolsPolicy = configuration.get<string>("toolsPolicy", "enabled").trim().toLowerCase();
    const toolsDisabled = toolsPolicy === "disabled";
    const abortController = new AbortController();

    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      token.onCancellationRequested(() => abortController.abort());
    }

    if (request.command === "tools") {
      await this.toolRegistry.refresh();
      const discovered = this.toolRegistry.getExecutableTools();
      stream.markdown(this.renderTools(discovered.map((tool) => tool.name)));
      return;
    }

    // --- Autonomous mode: run until completion checklist is satisfied --------
    if (request.command === "autonomous") {
      const maxAutoTurns = configuration.get<number>("maxAutonomousTurns", 30);
      const maxIdleTurns = configuration.get<number>("maxIdleTurns", 3);

      stream.progress("Starting autonomous agent loop…");
      const result = await runAutonomousLoop({
        maxTurns: maxAutoTurns,
        maxIdleTurns,
        userRequest: request.prompt,
        toolRegistry: this.toolRegistry,
        output: this.output,
        stream,
        token,
      });

      stream.markdown(
        `[LOCAL QWEN AUTONOMOUS] ${result.summary}\n\n*Completed in ${result.turns} turns.*`,
      );
      return;
    }

    // --- Intent extraction (Phase 1) -----------------------------------------
    let intent: LockedIntent = extractIntent(request.prompt);
    this.output.appendLine(
      `[local-qwen] intent: type=${intent.type} anchor="${intent.anchor.slice(0, 100)}"`,
    );

    // --- Session tracking (Phase 3) ------------------------------------------
    const tracker = new SessionTracker();

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    await this.toolRegistry.refresh();
    const allTools = this.toolRegistry.getExecutableTools();

    const enableWorkspaceSnapshot = configuration.get<boolean>("enableWorkspaceSnapshot", true);

    const systemContent = toolsDisabled
      ? [
          "TOOLS DISABLED: You do not have access to any file/system tools in this chat turn.",
          "Do not say you will read/edit files or run commands.",
          "Respond with diagnosis + concrete suggested fixes based only on the provided context.",
        ].join("\n")
      : [
          "You are an AI coding agent inside VS Code. You have tools to read files, edit code, run build commands, check diagnostics, and interact with GUI applications.",
          "",
          "EXECUTION CONTRACT: You are responsible for resolving the user's request in this workspace end-to-end.",
          "First pass: quickly parse user intent and classify as either (a) concrete fix, or (b) larger multi-step project.",
          "- Concrete fix: execute immediately with focused tools.",
          "- Larger project: produce a complete checklist/plan first; if scope/risk is high, ask for one approval, then execute against that checklist.",
          "- Always iterate until complete with evidence: inspect → change → verify.",
          "",
          "TIGHT LOOP RULE (must follow): verify → change → verify. If you make a code change, immediately validate with get_diagnostics and (when applicable) a runtime check.",
          "RUNTIME/UI VERIFICATION-FIRST PROTOCOL: For runtime/UI errors, use visual tools FIRST to confirm the error is live.",
          "- Your FIRST tool call for a runtime error should be localQwen_list_windows then localQwen_take_screenshot. Look at the live app before editing code.",
          "- If a visual tool returns a 'disabled' error: fall back to the code-path check (snapshot or read_file). Do not retry visual tools.",
          "- If visual tools are not in the tool list: check the snapshot open editor contents first (zero tool calls if the answer is there), then use read_file/grep_search.",
          "- Do NOT call read_file on files already shown under Open Editor Contents in the snapshot. You already have the content.",
          'If you believe you are in the same UI state/spot but cannot detect/confirm the error quickly, STOP and tell the user exactly: "idk what\'s going on how did you get to that spot". Then ask for the shortest reproduction steps (or skim the immediate prior chat/tool history if you created the state yourself).',
          "Do NOT waste turns on filesystem exploration via shell (find/ls/tree/cat). Prefer grep_search, file_search, and the workspace snapshot.",
          "",
          "Treat pasted logs and error messages as potentially stale. Before changing code to fix a specific URL, path, module name, or symbol (the locked intent anchor), first check the snapshot's open editor contents (if the relevant file is visible there, you already have the answer — no tool call needed), then if needed use read_file, file_search, or grep_search.",
          "CRITICAL: reading the relevant source file IS the check. If you read_file on the file that would logically contain the error anchor (e.g. the asset loader, the component, the config) and the exact failing string is not present, you have your answer — the error is stale. Do not redundantly grep_search, list_dir, or read additional files to re-confirm what you already know. One authoritative read of the right file is sufficient.",
          "If the failing path/module from the error no longer appears in the workspace (for example, grep_search returns 0 matches, or read_file of the source shows a different path), explain that the error log looks outdated or already fixed and do not edit files to reintroduce that path.",
          "When the failing path/module no longer exists in the workspace, do NOT keep searching the filesystem. Switch to verification immediately: UI repro with visual tools if available; otherwise boot/smoke + ask the user to confirm.",
          "Only perform edits when there is a clear, current reference in the workspace that should be changed; prefer a no-op explanation over inventing new failing paths or resurrecting ones that have been removed.",
          "",
          enableWorkspaceSnapshot
            ? "A complete workspace snapshot — full file tree, build config, and project metadata — is provided in your context. It tells you exactly where every file lives. Start from that rather than running shell exploration."
            : "Use the available tools to inspect files, project structure, and configs as needed instead of assuming a preloaded snapshot.",
          "",
          "CRITICAL — RESPONSE STYLE: Act, don't narrate. Emit TOOL CALLS, not paragraphs of reasoning.",
          "- If the snapshot already answers the question: respond in 1-3 sentences. Zero tool calls.",
          "- NEVER call read_file on a file whose full content is in Open Editor Contents.",
          "- For runtime/UI errors: FIRST action must be localQwen_list_windows + localQwen_take_screenshot.",
          "- Keep text under 3 sentences per tool turn. The bulk of your response should be tool calls.",
        ].join("\n");

    // Inject workspace snapshot so the model sees the full file tree and
    // project config (Vite publicDir, package.json, etc.) from turn 1 when enabled.
    const workspaceSnapshot = enableWorkspaceSnapshot ? await buildWorkspaceContextSnapshot() : "";

    // Copilot prompt references (user-attached files/locations).
    // This is high-signal context and helps avoid needless searching.
    const promptReferences = await renderPromptReferencesContext(request.references);

    const messages: LlmMessage[] = [
      { role: "system", content: systemContent },
      ...(workspaceSnapshot ? [{ role: "system" as const, content: workspaceSnapshot }] : []),
      ...(promptReferences ? [{ role: "system" as const, content: promptReferences }] : []),
      { role: "user", content: request.prompt },
    ];

    // Advice-only mode: match raw ollama behavior (no tools, no agentic loop).
    if (toolsDisabled) {
      const preparedMessages = await prepareMessagesWithVision(
        messages as OllamaVisionMessage[],
        model,
        endpoint,
        this.output,
        undefined,
        visionModel,
      );

      const chatRequest: ChatRequest = {
        endpoint,
        model,
        tools: [],
        messages: preparedMessages as LlmMessage[],
        temperature,
      };

      void appendOutboundOllamaRequestLog({
        output: this.output,
        source: "participant",
        request: {
          endpoint: chatRequest.endpoint,
          model: chatRequest.model,
          temperature: chatRequest.temperature,
          messages: chatRequest.messages,
          tools: chatRequest.tools,
        },
      });

      const result = await this.llmClient.chat(chatRequest, abortController.signal);
      stream.markdown(result.message.content ?? "");
      return;
    }

    let finalAnswer = "";
    let latestEvidence = "(none yet)";
    // Track files read this session so we can avoid re-reading and can tell the
    // LLM what workspace context it already has.
    const filesVisited = new Set<string>();

    for (let step = 0; step < maxAgentSteps; step += 1) {
      // Re-select tools fresh each turn, passing filesVisited for workspace-awareness.
      let selectedTools = selectTools(
        intent,
        allTools,
        (line) => this.output.appendLine(line),
        filesVisited,
      );

      // Inject execution anchor into the system message each turn.
      const anchor = buildExecutionAnchor({
        originalRequest: request.prompt,
        lockedIntent: intent,
        latestEvidence,
        sessionSummary: tracker.getSummary(),
        workspaceRoot,
        filesVisited: [...filesVisited],
      });
      messages[0] = {
        role: "system",
        content: [anchor, systemContent].filter(Boolean).join("\n\n"),
      };

      // Prepare messages with transparent vision support for any model
      const preparedMessages = await prepareMessagesWithVision(
        messages as OllamaVisionMessage[],
        model,
        endpoint,
        this.output,
        undefined,
        visionModel,
      );

      const chatRequest: ChatRequest = {
        endpoint,
        model,
        tools: this.toLlmTools(selectedTools),
        messages: preparedMessages as LlmMessage[],
        temperature,
      };

      void appendOutboundOllamaRequestLog({
        output: this.output,
        source: "participant",
        request: {
          endpoint: chatRequest.endpoint,
          model: chatRequest.model,
          temperature: chatRequest.temperature,
          messages: chatRequest.messages,
          tools: chatRequest.tools,
        },
      });

      const result = await this.llmClient.chat(chatRequest, abortController.signal);

      const assistantMessage = result.message;

      // Ensure tool calls have stable IDs so tool result messages can reference them.
      if (assistantMessage.tool_calls?.length) {
        assistantMessage.tool_calls = assistantMessage.tool_calls.map((call, index) => ({
          ...call,
          id: call.id ?? `call_${step + 1}_${index + 1}`,
        }));
      }
      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];

      // Count mutations for this turn (Phase 3).
      let turnMutations = 0;
      let codeMutationOccurred = false;
      const toolCallCount = toolCalls.length;

      if (toolCalls.length === 0) {
        tracker.recordTurn({
          turn: step + 1,
          toolCallCount: 0,
          mutationCount: 0,
          intentType: intent.type,
        });
        finalAnswer = assistantMessage.content ?? "";
        break;
      }

      const toolResultSummaries: string[] = [];

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = this.parseToolArgs(toolCall);
        const toolCallId = toolCall.id ?? `call_${step + 1}_${toolName}`;

        if (SessionTracker.isMutationTool(toolName)) {
          turnMutations += 1;
        }

        if (
          toolName === "write_file" ||
          toolName === "edit_file" ||
          toolName === "replace_in_files"
        ) {
          codeMutationOccurred = true;
        }

        // Track files read so the anchor can list them for the model.
        if (toolName === "read_file" && typeof toolArgs.filePath === "string") {
          filesVisited.add(toolArgs.filePath);
        }

        stream.progress(`Running tool ${toolName}…`);
        this.output.appendLine(`[local-qwen] tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

        try {
          const toolResult = await this.toolRegistry.execute(toolName, toolArgs);
          const resultStr = JSON.stringify(toolResult);
          toolResultSummaries.push(`${toolName}: ${resultStr}`);
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            tool_name: toolName,
            content: resultStr,
          });
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          toolResultSummaries.push(`${toolName}: ERROR ${errorText}`);
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            tool_name: toolName,
            content: JSON.stringify({ error: errorText }),
          });
        }
      }

      // Build evidence keeping the most recent result in full and compressing
      // older results to avoid crowding out the context window.
      if (toolResultSummaries.length > 0) {
        const latest = toolResultSummaries[toolResultSummaries.length - 1] ?? "";
        const older = toolResultSummaries
          .slice(0, -1)
          .map((s) => s.slice(0, 80))
          .join(" | ");
        latestEvidence = older ? `${older} | ${latest.slice(0, 800)}` : latest.slice(0, 800);
      }

      // Tight-loop verification: after code mutations, automatically collect
      // fresh VS Code diagnostics so the next turn can't "forget" to verify.
      // This is appended to the execution anchor as evidence (not as a tool message).
      if (codeMutationOccurred) {
        try {
          const diagnostics = await this.toolRegistry.execute("get_diagnostics", {
            severity: "error",
          });
          const diagStr = JSON.stringify(diagnostics).slice(0, 800);
          latestEvidence = `${latestEvidence} | auto_get_diagnostics: ${diagStr}`.slice(0, 1200);
          this.output.appendLine(`[local-qwen] auto verification: get_diagnostics(error)`);
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          latestEvidence = `${latestEvidence} | auto_get_diagnostics: ERROR ${errorText}`.slice(
            0,
            1200,
          );
          this.output.appendLine(
            `[local-qwen] auto verification failed: get_diagnostics(error) -> ${errorText}`,
          );
        }
      }

      intent = maybeRefineIntent(intent, latestEvidence);

      tracker.recordTurn({
        turn: step + 1,
        toolCallCount,
        mutationCount: turnMutations,
        intentType: intent.type,
      });

      this.output.appendLine(`[local-qwen] session: ${tracker.getSummary()}`);
    }

    if (!finalAnswer) {
      finalAnswer =
        "Agent stopped before producing a final answer. Try increasing `localQwen.maxAgentSteps`.";
    }

    stream.markdown(`[LOCAL QWEN] ${finalAnswer}`);

    void writeLatestDebugSnapshot({
      output: this.output,
      source: "participant",
      data: {
        request: {
          command: request.command,
          promptPreview: request.prompt.slice(0, 5000),
        },
        model: { endpoint, model, visionModel: visionModel || undefined, temperature },
        intent,
        session: {
          summary: tracker.getSummary(),
          latestEvidence,
          filesVisited: [...filesVisited].slice(0, 200),
        },
        result: {
          finalAnswerPreview: finalAnswer.slice(0, 8000),
        },
        notes: [
          "This file is overwritten each request to prevent stale debug buildup.",
          "Outbound JSONL logging (if enabled) is separate and may contain sensitive workspace context.",
        ],
      },
    });
  }

  /**
   * Safely parses tool call arguments whether they arrive as a raw JSON string
   * or as an already-parsed object.  Returns an empty object on any parse
   * failure rather than throwing.
   */
  private parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
    const raw = toolCall.function.arguments;

    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Log clearly rather than silently returning {}: executing a tool with
        // empty args causes confusing silent failures (e.g. read_file with no
        // filePath just errors with a non-obvious message).
        this.output.appendLine(
          `[local-qwen] WARNING: tool '${toolCall.function.name}' arguments are not valid JSON — raw: ${String(raw).slice(0, 120)}`,
        );
        return {};
      }
    }

    return raw ?? {};
  }

  /** Converts registry tool descriptors into the LLM-facing tool spec format. */
  private toLlmTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>,
  ): LlmToolSpec[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /** Renders the tool list as a Markdown bullet list for the `/tools` command. */
  private renderTools(toolNames: string[]): string {
    if (toolNames.length === 0) {
      return "No executable tools discovered yet. Configure `localQwen.toolDiscoveryRoots` and run refresh.";
    }

    return `Discovered tools:\n\n${toolNames.map((name) => `- ${name}`).join("\n")}`;
  }
}
