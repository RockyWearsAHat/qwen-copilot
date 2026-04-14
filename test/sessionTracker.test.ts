/**
 * Unit tests for SessionTracker.
 *
 * Critical regression coverage for Bug #1: MUTATION_TOOL_NAMES used to contain
 * old camelCase names (e.g. "editFile") that never matched any registered tool.
 * isMutationTool() always returned false, causing isStuck() to fire every 2 turns
 * unconditionally — even when the agent was actively mutating files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionTracker } from "../src/agent/sessionTracker";

describe("SessionTracker.isMutationTool", () => {
  it("returns true for the primary file-mutation tools (snake_case)", () => {
    const mutations = [
      "write_file",
      "edit_file",
      "replace_in_files",
      "run_in_terminal",
      "create_agent_checklist",
      "update_agent_checklist_item",
    ];
    for (const name of mutations) {
      assert.equal(
        SessionTracker.isMutationTool(name),
        true,
        `expected isMutationTool("${name}") === true`,
      );
    }
  });

  it("returns false for the old camelCase names (Bug #1 regression)", () => {
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
      assert.equal(
        SessionTracker.isMutationTool(name),
        false,
        `old camelCase name "${name}" should NOT match — it was never a registered tool`,
      );
    }
  });

  it("returns false for diagnostic/read-only tools", () => {
    const readOnly = ["read_file", "file_search", "grep_search", "get_diagnostics", "list_dir"];
    for (const name of readOnly) {
      assert.equal(
        SessionTracker.isMutationTool(name),
        false,
        `expected isMutationTool("${name}") === false`,
      );
    }
  });
});

describe("SessionTracker.isStuck", () => {
  it("returns false after turns that all contain at least one mutation", () => {
    const tracker = new SessionTracker();
    tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 1, intentType: "general" });
    tracker.recordTurn({ turn: 2, toolCallCount: 3, mutationCount: 2, intentType: "general" });
    assert.equal(tracker.isStuck(), false);
  });

  it("returns true after ZERO_MUTATION_LIMIT consecutive zero-mutation turns", () => {
    const tracker = new SessionTracker();
    tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 0, intentType: "general" });
    tracker.recordTurn({ turn: 2, toolCallCount: 3, mutationCount: 0, intentType: "general" });
    assert.equal(tracker.isStuck(), true);
  });

  it("returns false when a mutation turn breaks a prior zero-mutation streak", () => {
    const tracker = new SessionTracker();
    tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 0, intentType: "general" });
    tracker.recordTurn({ turn: 2, toolCallCount: 1, mutationCount: 1, intentType: "general" });
    tracker.recordTurn({ turn: 3, toolCallCount: 2, mutationCount: 0, intentType: "general" });
    assert.equal(tracker.isStuck(), false);
  });

  it("returns false with fewer turns than ZERO_MUTATION_LIMIT", () => {
    const tracker = new SessionTracker();
    tracker.recordTurn({ turn: 1, toolCallCount: 2, mutationCount: 0, intentType: "general" });
    assert.equal(tracker.isStuck(), false);
  });

  it("getEscalationPrompt returns a non-empty actionable string", () => {
    const tracker = new SessionTracker();
    const prompt = tracker.getEscalationPrompt();
    assert.ok(prompt.length > 0, "escalation prompt must be non-empty");
    assert.ok(
      /mutation|action|apply|fix/i.test(prompt),
      "escalation prompt should include a concrete action directive",
    );
  });
});
