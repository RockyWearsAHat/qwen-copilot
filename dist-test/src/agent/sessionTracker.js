"use strict";
/**
 * @module sessionTracker
 *
 * Tracks per-session agent progress to detect and escalate zero-mutation loops.
 *
 * Design goals:
 *  - Treat repeated no-progress turns (tool calls with no file mutations) as
 *    correctness regressions per the agent standards.
 *  - Provide a structured escalation prompt that forces the next turn to act.
 *  - Expose a machine-readable summary for structured logging.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionTracker = void 0;
/**
 * Manages turn-level telemetry for one agent session.
 *
 * Create one instance per `handleRequest` invocation.
 */
class SessionTracker {
    turns = [];
    /**
     * Consecutive zero-mutation turns required before `isStuck()` returns true.
     *
     * Set to 2 — one diagnostic turn can be legitimate, but two in a row is
     * strong evidence the agent is looping without making progress.
     */
    static ZERO_MUTATION_LIMIT = 2;
    /**
     * Names of tool call operations that are considered mutations.
     *
     * These are the actual snake_case registered handler names derived from
     * the `tool_*` prefix-stripped exports in handlers.ts / toolRegistry.ts.
     * Anything not in this set is counted as diagnostic-only.
     */
    static MUTATION_TOOL_NAMES = new Set([
        // File system mutations
        "write_file",
        "edit_file",
        "replace_in_files",
        // Shell / terminal (may create files, install packages, run builds, etc.)
        "run_in_terminal",
        // Agent checklist mutations
        "create_agent_checklist",
        "update_agent_checklist_item",
        // GUI interactions
        "gui_click",
        "gui_type",
        "gui_scroll",
        "gui_key",
        "gui_key_hold",
        "launch_app",
        "focus_window",
    ]);
    /**
     * Determines whether a tool call by name constitutes a mutation.
     *
     * Exposed statically so callers can classify before recording.
     */
    static isMutationTool(toolName) {
        return SessionTracker.MUTATION_TOOL_NAMES.has(toolName);
    }
    /**
     * Records the activity of one completed agent turn.
     *
     * @param record - Populated `TurnRecord` for the turn just completed.
     */
    recordTurn(record) {
        this.turns.push(record);
        this.logTurn(record);
    }
    /**
     * Returns `true` when the last {@link ZERO_MUTATION_LIMIT} turns all had
     * zero mutations, indicating the agent is stuck in a diagnostic loop.
     */
    isStuck() {
        const recent = this.turns.slice(-SessionTracker.ZERO_MUTATION_LIMIT);
        return (recent.length >= SessionTracker.ZERO_MUTATION_LIMIT &&
            recent.every((t) => t.mutationCount === 0));
    }
    /**
     * Returns a compact prompt fragment injected at the start of the next turn
     * when the session is stuck.  Forces the model to act rather than diagnose.
     */
    getEscalationPrompt() {
        return ("ESCALATION — you have made no file changes for multiple turns.\n" +
            "find, ls, list_dir, read_file, grep_search DO NOT count as progress by themselves.\n" +
            "The complete file tree was already provided at the start of this conversation.\n" +
            "You must now either (a) apply a concrete, minimal edit (edit_file, write_file, replace_in_files, or run_in_terminal) that directly addresses the locked intent based on existing evidence, or (b) if the latest tool results show that the reported URL/path/module/symbol from the error no longer appears anywhere in the workspace (for example grep_search returns 0 matches), clearly explain that the error log looks stale or already fixed and stop without making further edits.\n" +
            "Do not keep calling only read or discovery tools, and do not reintroduce deleted resource paths just to match an outdated error message.");
    }
    /** Total number of turns recorded in this session. */
    get turnCount() {
        return this.turns.length;
    }
    /** Total mutations across all turns in this session. */
    get totalMutations() {
        return this.turns.reduce((sum, t) => sum + t.mutationCount, 0);
    }
    /**
     * Returns a single-line machine-readable session summary.
     *
     * Suitable for structured log output.
     */
    getSummary() {
        return (`turns=${this.turns.length} ` +
            `total_mutations=${this.totalMutations} ` +
            `stuck=${this.isStuck()}`);
    }
    logTurn(record) {
        console.log(`[session-tracker] ` +
            `turn=${record.turn} ` +
            `tools=${record.toolCallCount} ` +
            `mutations=${record.mutationCount} ` +
            `intent=${record.intentType} ` +
            `stuck=${this.isStuck()}`);
    }
}
exports.SessionTracker = SessionTracker;
//# sourceMappingURL=sessionTracker.js.map