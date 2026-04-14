"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalAgentRunner = void 0;
const vscode = __importStar(require("vscode"));
const ollamaClient_1 = require("../llm/ollamaClient");
const intentExtractor_1 = require("../intent/intentExtractor");
const toolSelector_1 = require("../tools/toolSelector");
const sessionTracker_1 = require("./sessionTracker");
const executionAnchor_1 = require("../prompt/executionAnchor");
const autonomousLoop_1 = require("./autonomousLoop");
const ollamaVision_1 = require("../llm/ollamaVision");
const snapshots_1 = require("../llm/provider/context/snapshots");
const outboundLogger_1 = require("../llm/provider/debug/outboundLogger");
const latestSnapshot_1 = require("../llm/provider/debug/latestSnapshot");
const promptReferences_1 = require("./promptReferences");
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
class LocalAgentRunner {
    toolRegistry;
    output;
    llmClient = new ollamaClient_1.OllamaClient();
    constructor(toolRegistry, output) {
        this.toolRegistry = toolRegistry;
        this.output = output;
    }
    async handleRequest(request, stream, token) {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const endpoint = configuration.get("endpoint", "http://localhost:11434");
        const model = configuration.get("model", "qwen2.5:32b");
        const visionModel = configuration.get("visionModel", "").trim();
        const maxAgentSteps = configuration.get("maxAgentSteps", 6);
        const temperature = configuration.get("temperature", 0.2);
        const toolsPolicy = configuration.get("toolsPolicy", "enabled").trim().toLowerCase();
        const toolsDisabled = toolsPolicy === "disabled";
        const abortController = new AbortController();
        if (token.isCancellationRequested) {
            abortController.abort();
        }
        else {
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
            const maxAutoTurns = configuration.get("maxAutonomousTurns", 30);
            const maxIdleTurns = configuration.get("maxIdleTurns", 3);
            stream.progress("Starting autonomous agent loop…");
            const result = await (0, autonomousLoop_1.runAutonomousLoop)({
                maxTurns: maxAutoTurns,
                maxIdleTurns,
                userRequest: request.prompt,
                toolRegistry: this.toolRegistry,
                output: this.output,
                stream,
                token,
            });
            stream.markdown(`[LOCAL QWEN AUTONOMOUS] ${result.summary}\n\n*Completed in ${result.turns} turns.*`);
            return;
        }
        // --- Intent extraction (Phase 1) -----------------------------------------
        let intent = (0, intentExtractor_1.extractIntent)(request.prompt);
        this.output.appendLine(`[local-qwen] intent: type=${intent.type} anchor="${intent.anchor.slice(0, 100)}"`);
        // --- Session tracking (Phase 3) ------------------------------------------
        const tracker = new sessionTracker_1.SessionTracker();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await this.toolRegistry.refresh();
        const allTools = this.toolRegistry.getExecutableTools();
        const enableWorkspaceSnapshot = configuration.get("enableWorkspaceSnapshot", true);
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
                "RUNTIME/UI VERIFICATION-FIRST PROTOCOL: Prefer to confirm the error exists right now before editing.",
                "- If machine interaction tools are enabled and can run: reproduce/confirm in the live UI first (take_screenshot → ocr_find_text; optionally focus_window/launch_app/gui_*), then fix, then repeat the SAME UI check to verify it’s gone.",
                "- If machine interaction tools are disabled/unavailable: do a quick boot/smoke check instead:",
                "  1) start the dev server via run_in_terminal (isBackground=true),",
                "  2) watch terminal output briefly (get_terminal_output / await_terminal) for obvious crashes,",
                "  3) use launch_app with the served URL so it opens in the system default browser (if launch_app is unavailable, ask the user to open the served URL manually),",
                "  4) if you still can’t directly observe the UI error, tell the user it *appears* resolved and ask them to confirm + provide exact repro steps if it persists.",
                'If you believe you are in the same UI state/spot but cannot detect/confirm the error quickly, STOP and tell the user exactly: "idk what\'s going on how did you get to that spot". Then ask for the shortest reproduction steps (or skim the immediate prior chat/tool history if you created the state yourself).',
                "Do NOT waste turns on filesystem exploration via shell (find/ls/tree/cat). Prefer grep_search, file_search, and the workspace snapshot.",
                "",
                "Treat pasted logs and error messages as potentially stale. Before changing code to fix a specific URL, path, module name, or symbol (the locked intent anchor), first check whether that exact string still appears anywhere in the current workspace using read_file, file_search, or grep_search.",
                "If the failing path/module from the error no longer appears in the workspace (for example, grep_search returns 0 matches), explain that the error log looks outdated or already fixed and do not edit files to reintroduce that path.",
                "When the failing path/module no longer exists in the workspace, do NOT keep searching the filesystem. Switch to verification: UI repro if possible; otherwise boot/smoke + ask the user to confirm.",
                "Only perform edits when there is a clear, current reference in the workspace that should be changed; prefer a no-op explanation over inventing new failing paths or resurrecting ones that have been removed.",
                "",
                enableWorkspaceSnapshot
                    ? "A complete workspace snapshot — full file tree, build config, and project metadata — is provided in your context. It tells you exactly where every file lives. Start from that rather than running shell exploration."
                    : "Use the available tools to inspect files, project structure, and configs as needed instead of assuming a preloaded snapshot.",
            ].join("\n");
        // Inject workspace snapshot so the model sees the full file tree and
        // project config (Vite publicDir, package.json, etc.) from turn 1 when enabled.
        const workspaceSnapshot = enableWorkspaceSnapshot ? await (0, snapshots_1.buildWorkspaceContextSnapshot)() : "";
        // Copilot prompt references (user-attached files/locations).
        // This is high-signal context and helps avoid needless searching.
        const promptReferences = await (0, promptReferences_1.renderPromptReferencesContext)(request.references);
        const messages = [
            { role: "system", content: systemContent },
            ...(workspaceSnapshot ? [{ role: "system", content: workspaceSnapshot }] : []),
            ...(promptReferences ? [{ role: "system", content: promptReferences }] : []),
            { role: "user", content: request.prompt },
        ];
        // Advice-only mode: match raw ollama behavior (no tools, no agentic loop).
        if (toolsDisabled) {
            const preparedMessages = await (0, ollamaVision_1.prepareMessagesWithVision)(messages, model, endpoint, this.output, undefined, visionModel);
            const chatRequest = {
                endpoint,
                model,
                tools: [],
                messages: preparedMessages,
                temperature,
            };
            void (0, outboundLogger_1.appendOutboundOllamaRequestLog)({
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
        const filesVisited = new Set();
        for (let step = 0; step < maxAgentSteps; step += 1) {
            // Re-select tools fresh each turn, passing filesVisited for workspace-awareness.
            let selectedTools = (0, toolSelector_1.selectTools)(intent, allTools, (line) => this.output.appendLine(line), filesVisited);
            // Inject execution anchor into the system message each turn.
            const anchor = (0, executionAnchor_1.buildExecutionAnchor)({
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
            const preparedMessages = await (0, ollamaVision_1.prepareMessagesWithVision)(messages, model, endpoint, this.output, undefined, visionModel);
            const chatRequest = {
                endpoint,
                model,
                tools: this.toLlmTools(selectedTools),
                messages: preparedMessages,
                temperature,
            };
            void (0, outboundLogger_1.appendOutboundOllamaRequestLog)({
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
            const toolResultSummaries = [];
            for (const toolCall of toolCalls) {
                const toolName = toolCall.function.name;
                const toolArgs = this.parseToolArgs(toolCall);
                const toolCallId = toolCall.id ?? `call_${step + 1}_${toolName}`;
                if (sessionTracker_1.SessionTracker.isMutationTool(toolName)) {
                    turnMutations += 1;
                }
                if (toolName === "write_file" ||
                    toolName === "edit_file" ||
                    toolName === "replace_in_files") {
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
                }
                catch (error) {
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
                }
                catch (error) {
                    const errorText = error instanceof Error ? error.message : String(error);
                    latestEvidence = `${latestEvidence} | auto_get_diagnostics: ERROR ${errorText}`.slice(0, 1200);
                    this.output.appendLine(`[local-qwen] auto verification failed: get_diagnostics(error) -> ${errorText}`);
                }
            }
            intent = (0, intentExtractor_1.maybeRefineIntent)(intent, latestEvidence);
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
        void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
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
    parseToolArgs(toolCall) {
        const raw = toolCall.function.arguments;
        if (typeof raw === "string") {
            try {
                return JSON.parse(raw);
            }
            catch {
                // Log clearly rather than silently returning {}: executing a tool with
                // empty args causes confusing silent failures (e.g. read_file with no
                // filePath just errors with a non-obvious message).
                this.output.appendLine(`[local-qwen] WARNING: tool '${toolCall.function.name}' arguments are not valid JSON — raw: ${String(raw).slice(0, 120)}`);
                return {};
            }
        }
        return raw ?? {};
    }
    /** Converts registry tool descriptors into the LLM-facing tool spec format. */
    toLlmTools(tools) {
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
    renderTools(toolNames) {
        if (toolNames.length === 0) {
            return "No executable tools discovered yet. Configure `localQwen.toolDiscoveryRoots` and run refresh.";
        }
        return `Discovered tools:\n\n${toolNames.map((name) => `- ${name}`).join("\n")}`;
    }
}
exports.LocalAgentRunner = LocalAgentRunner;
//# sourceMappingURL=localAgent.js.map