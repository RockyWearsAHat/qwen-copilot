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
exports.runAutonomousLoop = runAutonomousLoop;
const vscode = __importStar(require("vscode"));
const ollamaClient_1 = require("../llm/ollamaClient");
const handlers_1 = require("../tools/handlers");
const ollamaVision_1 = require("../llm/ollamaVision");
const sessionTracker_1 = require("./sessionTracker");
const snapshots_1 = require("../llm/provider/context/snapshots");
const latestSnapshot_1 = require("../llm/provider/debug/latestSnapshot");
/**
 * Autonomous agent loop that drives the LLM through tool calls
 * until the completion checklist is fully satisfied.
 */
async function runAutonomousLoop(options) {
    const { maxTurns, maxIdleTurns, userRequest, toolRegistry, output, progress, token, stream } = options;
    (0, handlers_1.resetAgentState)();
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const endpoint = configuration.get("endpoint", "http://localhost:11434");
    const model = configuration.get("model", "qwen2.5:32b");
    const visionModel = configuration.get("visionModel", "").trim();
    const temperature = configuration.get("temperature", 0.2);
    const enableWorkspaceSnapshot = configuration.get("enableWorkspaceSnapshot", true);
    const abortController = new AbortController();
    if (token?.isCancellationRequested) {
        abortController.abort();
    }
    else {
        token?.onCancellationRequested(() => abortController.abort());
    }
    const llmClient = new ollamaClient_1.OllamaClient();
    const tracker = new sessionTracker_1.SessionTracker();
    await toolRegistry.refresh();
    const allTools = toolRegistry.getExecutableTools();
    const toolSpecs = allTools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const systemPrompt = buildAgentSystemPrompt();
    // Inject workspace snapshot so the model sees the full file tree and
    // project config from turn 1 when enabled.
    const workspaceSnapshot = enableWorkspaceSnapshot ? await (0, snapshots_1.buildWorkspaceContextSnapshot)() : "";
    const messages = [
        { role: "system", content: systemPrompt },
        ...(workspaceSnapshot ? [{ role: "system", content: workspaceSnapshot }] : []),
        {
            role: "user",
            content: [
                userRequest,
                "",
                "**IMPORTANT — follow the two-checklist system:**",
                "1. Call `get_completion_checklist` to load the user's acceptance criteria (read-only, never write to it).",
                "2. Call `get_agent_checklist` to check for an existing work plan.",
                "3. If no agent work plan exists, call `create_agent_checklist` with a thorough ordered list of sub-tasks.",
                "4. Work through the agent checklist item by item, ticking each off with `update_agent_checklist_item`.",
                "5. Call `agent_progress` only at major section boundaries (not per sub-task) to update the user.",
                "6. When all agent checklist items are done, do a final post-op pass: `get_completion_checklist` → verify every criterion → `agent_progress` with status='completed'.",
                "Do not stop until ALL user acceptance criteria are verified satisfied.",
            ].join("\n"),
        },
    ];
    let turnCount = 0;
    let idleTurns = 0;
    let lastMutationTurn = 0;
    const mutationTools = new Set([
        "write_file",
        "edit_file",
        "replace_in_files",
        "run_in_terminal",
        "gui_click",
        "gui_type",
        "gui_scroll",
        "gui_key",
        "create_agent_checklist",
        "update_agent_checklist_item",
    ]);
    while (turnCount < maxTurns) {
        if (token?.isCancellationRequested) {
            void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
                output,
                source: "autonomous",
                data: {
                    status: "cancelled",
                    turnCount,
                    maxTurns,
                    userRequestPreview: userRequest.slice(0, 5000),
                },
            });
            return { success: false, summary: "Cancelled by user.", turns: turnCount };
        }
        turnCount++;
        output.appendLine(`\n[agent-loop] ─── Turn ${turnCount}/${maxTurns} ───`);
        progress?.report({ message: `Autonomous turn ${turnCount}/${maxTurns}` });
        stream?.progress(`Agent turn ${turnCount}/${maxTurns}`);
        // Prepare messages with vision support
        const visionMessages = await (0, ollamaVision_1.prepareMessagesWithVision)(messages, model, endpoint, output, undefined, visionModel);
        const chatRequest = {
            endpoint,
            model,
            tools: toolSpecs,
            messages: visionMessages,
            temperature,
        };
        const result = await llmClient.chat(chatRequest, abortController.signal);
        const assistantMessage = result.message;
        messages.push(assistantMessage);
        const toolCalls = assistantMessage.tool_calls ?? [];
        // No tool calls → check if agent thinks it's done
        if (toolCalls.length === 0) {
            output.appendLine("[agent-loop] No tool calls in response.");
            const agentState = (0, handlers_1.getAgentState)();
            if (agentState.status === "completed") {
                output.appendLine("[agent-loop] Agent reports completed.");
                // Verify checklist
                try {
                    const checklistResult = (await toolRegistry.execute("get_completion_checklist", {}));
                    if (checklistResult.allComplete) {
                        void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
                            output,
                            source: "autonomous",
                            data: {
                                status: "completed",
                                turns: turnCount,
                                checklist: checklistResult,
                                userRequestPreview: userRequest.slice(0, 5000),
                            },
                        });
                        return {
                            success: true,
                            summary: `Completed in ${turnCount} turns. ${checklistResult.summary}`,
                            turns: turnCount,
                        };
                    }
                    else {
                        messages.push({
                            role: "user",
                            content: `The checklist is NOT fully complete yet: ${checklistResult.summary}\nContinue working. Do not stop until every item is checked.`,
                        });
                        continue;
                    }
                }
                catch {
                    // No checklist = done
                    void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
                        output,
                        source: "autonomous",
                        data: {
                            status: "completed",
                            turns: turnCount,
                            checklist: null,
                            userRequestPreview: userRequest.slice(0, 5000),
                        },
                    });
                    return {
                        success: true,
                        summary: `Completed in ${turnCount} turns (no checklist found).`,
                        turns: turnCount,
                    };
                }
            }
            if (agentState.status === "blocked" || agentState.status === "failed") {
                void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
                    output,
                    source: "autonomous",
                    data: {
                        status: agentState.status,
                        turns: turnCount,
                        blocker: agentState.blockerDescription ?? assistantMessage.content ?? "unknown",
                        userRequestPreview: userRequest.slice(0, 5000),
                    },
                });
                return {
                    success: false,
                    summary: `Agent ${agentState.status}: ${agentState.blockerDescription ?? assistantMessage.content ?? "unknown"}`,
                    turns: turnCount,
                };
            }
            idleTurns++;
            if (idleTurns >= maxIdleTurns) {
                messages.push({
                    role: "user",
                    content: `You have not made progress for ${idleTurns} turns. Call a tool to make progress, report status via agent_progress, or explain the blocker. Idle loops are treated as failure.`,
                });
            }
            continue;
        }
        // Execute tool calls
        idleTurns = 0;
        let turnMutations = 0;
        for (const toolCall of toolCalls) {
            const toolName = toolCall.function.name;
            const toolArgs = parseToolArgs(toolCall);
            if (mutationTools.has(toolName)) {
                turnMutations++;
            }
            output.appendLine(`[agent-loop] Tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`);
            stream?.progress(`Running ${toolName}…`);
            try {
                const toolResult = await toolRegistry.execute(toolName, toolArgs);
                const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
                const toolMessage = {
                    role: "tool",
                    tool_name: toolName,
                    content: resultStr.length > 20000 ? resultStr.slice(0, 20000) + "\n...[truncated]" : resultStr,
                };
                // Attach screenshot images for vision analysis
                if (toolName === "take_screenshot" &&
                    typeof toolResult === "object" &&
                    toolResult !== null &&
                    "image" in toolResult) {
                    toolMessage.images = [toolResult.image];
                }
                messages.push(toolMessage);
                output.appendLine(`[agent-loop] Result: ${resultStr.slice(0, 300)}`);
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                output.appendLine(`[agent-loop] Tool error: ${errMsg}`);
                messages.push({
                    role: "tool",
                    tool_name: toolName,
                    content: JSON.stringify({ error: errMsg }),
                });
            }
        }
        if (turnMutations > 0) {
            lastMutationTurn = turnCount;
        }
        // Best-effort overwrite snapshot every turn (compact).
        void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
            output,
            source: "autonomous",
            data: {
                status: "running",
                turn: turnCount,
                maxTurns,
                lastMutationTurn,
                toolCalls: toolCalls.map((c) => ({ name: c.function.name })),
                session: tracker.getSummary(),
                userRequestPreview: userRequest.slice(0, 5000),
            },
        });
        tracker.recordTurn({
            turn: turnCount,
            toolCallCount: toolCalls.length,
            mutationCount: turnMutations,
            intentType: "autonomous",
        });
        void (0, latestSnapshot_1.writeLatestDebugSnapshot)({
            output,
            source: "autonomous",
            data: {
                status: "stopped",
                turns: turnCount,
                maxTurns,
                userRequestPreview: userRequest.slice(0, 5000),
            },
        });
        // Warn about idle mutations
        if (turnCount - lastMutationTurn > maxIdleTurns && lastMutationTurn > 0) {
            messages.push({
                role: "user",
                content: `Warning: ${turnCount - lastMutationTurn} turns since last mutation. Are you progressing? If stuck, call agent_progress with status='blocked'.`,
            });
        }
        // Trim history to prevent context overflow (keep system + last N messages)
        const maxHistoryMessages = 80;
        if (messages.length > maxHistoryMessages) {
            const systemMsg = messages[0];
            const recentMessages = messages.slice(-(maxHistoryMessages - 1));
            messages.length = 0;
            messages.push(systemMsg, ...recentMessages);
            output.appendLine(`[agent-loop] Trimmed history to ${messages.length} messages.`);
        }
    }
    return {
        success: false,
        summary: `Agent exhausted maximum turns (${maxTurns}). State: ${JSON.stringify((0, handlers_1.getAgentState)())}`,
        turns: turnCount,
    };
}
function parseToolArgs(toolCall) {
    const raw = toolCall.function.arguments;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        }
        catch {
            // Log clearly rather than silently returning {}: executing a tool with
            // empty args causes confusing silent failures (e.g. read_file with no
            // filePath just errors with a non-obvious message).
            console.warn(`[local-qwen] tool '${toolCall.function.name}' has unparseable JSON arguments — raw: ${String(raw).slice(0, 120)}`);
            return {};
        }
    }
    return raw ?? {};
}
function buildAgentSystemPrompt() {
    return [
        "You are an AI coding agent running autonomously inside VS Code.",
        "You have tools for reading files, editing code, running terminal commands, GUI interaction, HTTP requests, and checking diagnostics.",
        "",
        "## Two-Checklist Architecture — read this carefully",
        "",
        "### 1. User Acceptance Gate: `.github/completion-checklist.md`",
        "- Written by the USER before this conversation. Defines what 'done' means.",
        "- Read with `get_completion_checklist`.",
        "- **NEVER write to this file.** It is strictly read-only from the agent's perspective.",
        "- Load it on Turn 1. Verify against it in the final post-op pass.",
        "",
        "### 2. Agent Internal Work Plan: `.github/agent-checklist.md`",
        "- Created by the agent at the start of each request with `create_agent_checklist`.",
        "- Contains specific, concrete sub-tasks decomposed from the user's full request.",
        "- Read with `get_agent_checklist`. Tick items with `update_agent_checklist_item`.",
        "- This is entirely separate from the user's file — creating it NEVER overwrites `completion-checklist.md`.",
        "- Typical size: 10–50 items for a complex request, grouped by logical section.",
        "- This is your primary navigation tool. Consult it every few turns.",
        "",
        "## Workflow",
        "",
        "On a new request:",
        "- Load user acceptance criteria with `get_completion_checklist`.",
        "- Check for an existing work plan with `get_agent_checklist`. If none exists, create one with `create_agent_checklist` listing concrete sub-tasks.",
        "",
        "During execution:",
        "- Consult `get_agent_checklist` to find the next unchecked item, do that work, then tick it with `update_agent_checklist_item`.",
        "- Verify code changes with `get_diagnostics`.",
        "- Call `agent_progress` at major milestones (not for every sub-task) to surface progress to the user.",
        "",
        "On completion:",
        "- Reload `get_completion_checklist` and verify each criterion against the actual workspace state before calling `agent_progress` with status='completed'.",
        "",
        "## Platform-specific testing",
        "- GUI apps: `run_in_terminal` (background) → `wait_for_condition` → `take_screenshot` → `analyze_image` → `gui_click/type/key`",
        "- Terminal apps: `run_in_terminal` → `get_terminal_output`",
        "- REST APIs: `http_request`",
        "",
        "## Hard rules",
        "- Never write to `.github/completion-checklist.md`",
        "- Always call `create_agent_checklist` at the start of a new request",
        "- `agent_progress` is for the USER — call it only at major section boundaries, not per sub-task",
        "- Never declare completion without the post-op verification pass",
        "- If stuck: `agent_progress` with status='blocked' and a specific blocker description",
        "- For missing-file / asset-loading errors: the workspace file tree is in your context — use it to find the correct path, then fix the code reference.",
    ].join("\n");
}
//# sourceMappingURL=autonomousLoop.js.map