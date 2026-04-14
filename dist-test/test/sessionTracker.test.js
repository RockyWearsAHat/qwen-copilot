"use strict";
/**
 * Unit tests for SessionTracker.
 *
 * Critical regression coverage for Bug #1: MUTATION_TOOL_NAMES used to contain
 * old camelCase names (e.g. "editFile") that never matched any registered tool.
 * isMutationTool() always returned false, causing isStuck() to fire every 2 turns
 * unconditionally — even when the agent was actively mutating files.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const sessionTracker_1 = require("../src/agent/sessionTracker");
(0, node_test_1.describe)("SessionTracker.isMutationTool", () => {
    (0, node_test_1.it)("returns true for the primary file-mutation tools (snake_case)", () => {
        const mutations = [
            "write_file",
            "edit_file",
            "replace_in_files",
            "run_in_terminal",
            "create_agent_checklist",
            "update_agent_checklist_item",
        ];
        for (const name of mutations) {
            strict_1.default.equal(sessionTracker_1.SessionTracker.isMutationTool(name), true, `expected isMutationTool("${name}") === true`);
        }
    });
    (0, node_test_1.it)("returns false for the old camelCase names (Bug #1 regression)", () => {
        const oldCamelCaseNames = [
            "editFile",
            "applyEdit",
            "createFile",
            "deleteFile",
            "runCommand",
            "writeFile",
            "renameFile",
            "moveFile",
        ];
        for (const name of oldCamelCaseNames) {
            strict_1.default.equal(sessionTracker_1.SessionTracker.isMutationTool(name), false, `old camelCase name "${name}" should NOT match — it was never a registered tool`);
        }
    });
    (0, node_test_1.it)("returns false for diagnostic/read-only tools", () => {
        const readOnly = ["read_file", "file_search", "grep_search", "get_diagnostics", "list_dir"];
        for (const name of readOnly) {
            strict_1.default.equal(sessionTracker_1.SessionTracker.isMutationTool(name), false, `expected isMutationTool("${name}") === false`);
        }
    });
});
(0, node_test_1.describe)("SessionTracker.isStuck", () => {
    (0, node_test_1.it)("returns false after turns that all contain at least one mutation", () => {
        const tracker = new sessionTracker_1.SessionTracker();
        tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 1, intentType: "general" });
        tracker.recordTurn({ turn: 2, toolCallCount: 3, mutationCount: 2, intentType: "general" });
        strict_1.default.equal(tracker.isStuck(), false);
    });
    (0, node_test_1.it)("returns true after ZERO_MUTATION_LIMIT consecutive zero-mutation turns", () => {
        const tracker = new sessionTracker_1.SessionTracker();
        tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 0, intentType: "general" });
        tracker.recordTurn({ turn: 2, toolCallCount: 3, mutationCount: 0, intentType: "general" });
        strict_1.default.equal(tracker.isStuck(), true);
    });
    (0, node_test_1.it)("returns false when a mutation turn breaks a prior zero-mutation streak", () => {
        const tracker = new sessionTracker_1.SessionTracker();
        tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 0, intentType: "general" });
        tracker.recordTurn({ turn: 2, toolCallCount: 1, mutationCount: 1, intentType: "general" });
        tracker.recordTurn({ turn: 3, toolCallCount: 2, mutationCount: 0, intentType: "general" });
        strict_1.default.equal(tracker.isStuck(), false);
    });
    (0, node_test_1.it)("returns false with fewer turns than ZERO_MUTATION_LIMIT", () => {
        const tracker = new sessionTracker_1.SessionTracker();
        tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 0, intentType: "general" });
        strict_1.default.equal(tracker.isStuck(), false);
    });
    (0, node_test_1.it)("getEscalationPrompt returns a non-empty actionable string", () => {
        const tracker = new sessionTracker_1.SessionTracker();
        const prompt = tracker.getEscalationPrompt();
        strict_1.default.ok(prompt.length > 0, "escalation prompt must be non-empty");
        strict_1.default.ok(/mutation|action|apply|fix/i.test(prompt), "escalation prompt should include a concrete action directive");
    });
});
//# sourceMappingURL=sessionTracker.test.js.map