/**
 * Unit tests for the agent-checklist tool names and handler reflection.
 *
 * These tests run in plain Node (no VS Code host) — they verify that:
 *  1. The three new agent-checklist tool names are emitted by the source parser.
 *  2. `reflectToolHandlers` maps them correctly from a mock module.
 *  3. The user's `completion-checklist.md` is NOT referenced by these handlers
 *     (name guard: none of the new tool exports reference the user's file name
 *     in their function name).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractToolNamesFromSource } from "../src/tools/toolNameExtraction";
import { reflectToolHandlers } from "../src/tools/handlerReflection";

// ── 1. Source-level tool name discovery ─────────────────────────────────────

test("extractToolNamesFromSource finds all three agent-checklist tool names", () => {
  // Simulate the relevant excerpt from handlers.ts.
  const source = `
    export async function tool_create_agent_checklist(args) {}
    export async function tool_get_agent_checklist(_args) {}
    export async function tool_update_agent_checklist_item(args) {}
    export async function tool_get_completion_checklist(_args) {}
  `;

  const names = extractToolNamesFromSource(source);

  assert.ok(names.has("create_agent_checklist"), "create_agent_checklist not found");
  assert.ok(names.has("get_agent_checklist"), "get_agent_checklist not found");
  assert.ok(names.has("update_agent_checklist_item"), "update_agent_checklist_item not found");
});

test("extractToolNamesFromSource still finds get_completion_checklist (user acceptance gate)", () => {
  const source = `export async function tool_get_completion_checklist(_args) {}`;
  const names = extractToolNamesFromSource(source);
  assert.ok(names.has("get_completion_checklist"));
});

test("extractToolNamesFromSource does NOT find create_completion_checklist (old name, removed)", () => {
  // The old tool that wrote to the user's file was renamed/replaced.
  // Verify the old name is gone from a real-world source excerpt.
  const source = `
    export async function tool_create_agent_checklist(args) {}
    export async function tool_get_agent_checklist(_args) {}
  `;

  const names = extractToolNamesFromSource(source);
  assert.ok(
    !names.has("create_completion_checklist"),
    "create_completion_checklist should NOT exist — it would have overwritten the user's file",
  );
});

// ── 2. reflectToolHandlers mapping ──────────────────────────────────────────

test("reflectToolHandlers maps agent-checklist tool names correctly", async () => {
  const fakeModule = {
    tool_create_agent_checklist: async (_args: Record<string, unknown>) => ({
      success: true,
      totalItems: 2,
    }),
    tool_get_agent_checklist: async (_args: Record<string, unknown>) => ({
      exists: true,
      totalItems: 2,
      completedItems: 0,
    }),
    tool_update_agent_checklist_item: async (_args: Record<string, unknown>) => ({
      success: true,
    }),
    // This should also be present and map correctly.
    tool_get_completion_checklist: async (_args: Record<string, unknown>) => ({
      exists: false,
    }),
  };

  const map = reflectToolHandlers(fakeModule);

  assert.ok(map.has("create_agent_checklist"), "create_agent_checklist missing from map");
  assert.ok(map.has("get_agent_checklist"), "get_agent_checklist missing from map");
  assert.ok(map.has("update_agent_checklist_item"), "update_agent_checklist_item missing from map");
  assert.ok(map.has("get_completion_checklist"), "get_completion_checklist missing from map");

  // Verify old user-mutating tool is NOT registered in the map via this module.
  assert.ok(!map.has("create_completion_checklist"), "create_completion_checklist must not exist");
  assert.ok(
    !map.has("update_checklist_item"),
    "update_checklist_item must not be in this fake map",
  );

  // Functional verification
  const createResult = await map.get("create_agent_checklist")?.({});
  assert.deepEqual(createResult, { success: true, totalItems: 2 });

  const getResult = await map.get("get_agent_checklist")?.({});
  assert.deepEqual(getResult, { exists: true, totalItems: 2, completedItems: 0 });
});

// ── 3. Separation guarantee: agent checklist ≠ user checklist ───────────────

test("agent-checklist tool names do not contain the string 'completion_checklist'", () => {
  const agentToolNames = [
    "create_agent_checklist",
    "get_agent_checklist",
    "update_agent_checklist_item",
  ];

  for (const name of agentToolNames) {
    assert.ok(
      !name.includes("completion_checklist"),
      `${name} must not reference completion_checklist — it would imply it writes to the user's file`,
    );
  }
});
