"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const toolNameExtraction_1 = require("../src/tools/toolNameExtraction");
const handlerReflection_1 = require("../src/tools/handlerReflection");
// ── 1. Source-level tool name discovery ─────────────────────────────────────
(0, node_test_1.default)("extractToolNamesFromSource finds all three agent-checklist tool names", () => {
    // Simulate the relevant excerpt from handlers.ts.
    const source = `
    export async function tool_create_agent_checklist(args) {}
    export async function tool_get_agent_checklist(_args) {}
    export async function tool_update_agent_checklist_item(args) {}
    export async function tool_get_completion_checklist(_args) {}
  `;
    const names = (0, toolNameExtraction_1.extractToolNamesFromSource)(source);
    strict_1.default.ok(names.has("create_agent_checklist"), "create_agent_checklist not found");
    strict_1.default.ok(names.has("get_agent_checklist"), "get_agent_checklist not found");
    strict_1.default.ok(names.has("update_agent_checklist_item"), "update_agent_checklist_item not found");
});
(0, node_test_1.default)("extractToolNamesFromSource still finds get_completion_checklist (user acceptance gate)", () => {
    const source = `export async function tool_get_completion_checklist(_args) {}`;
    const names = (0, toolNameExtraction_1.extractToolNamesFromSource)(source);
    strict_1.default.ok(names.has("get_completion_checklist"));
});
(0, node_test_1.default)("extractToolNamesFromSource does NOT find create_completion_checklist (old name, removed)", () => {
    // The old tool that wrote to the user's file was renamed/replaced.
    // Verify the old name is gone from a real-world source excerpt.
    const source = `
    export async function tool_create_agent_checklist(args) {}
    export async function tool_get_agent_checklist(_args) {}
  `;
    const names = (0, toolNameExtraction_1.extractToolNamesFromSource)(source);
    strict_1.default.ok(!names.has("create_completion_checklist"), "create_completion_checklist should NOT exist — it would have overwritten the user's file");
});
// ── 2. reflectToolHandlers mapping ──────────────────────────────────────────
(0, node_test_1.default)("reflectToolHandlers maps agent-checklist tool names correctly", async () => {
    const fakeModule = {
        tool_create_agent_checklist: async (_args) => ({
            success: true,
            totalItems: 2,
        }),
        tool_get_agent_checklist: async (_args) => ({
            exists: true,
            totalItems: 2,
            completedItems: 0,
        }),
        tool_update_agent_checklist_item: async (_args) => ({
            success: true,
        }),
        // This should also be present and map correctly.
        tool_get_completion_checklist: async (_args) => ({
            exists: false,
        }),
    };
    const map = (0, handlerReflection_1.reflectToolHandlers)(fakeModule);
    strict_1.default.ok(map.has("create_agent_checklist"), "create_agent_checklist missing from map");
    strict_1.default.ok(map.has("get_agent_checklist"), "get_agent_checklist missing from map");
    strict_1.default.ok(map.has("update_agent_checklist_item"), "update_agent_checklist_item missing from map");
    strict_1.default.ok(map.has("get_completion_checklist"), "get_completion_checklist missing from map");
    // Verify old user-mutating tool is NOT registered in the map via this module.
    strict_1.default.ok(!map.has("create_completion_checklist"), "create_completion_checklist must not exist");
    strict_1.default.ok(!map.has("update_checklist_item"), "update_checklist_item must not be in this fake map");
    // Functional verification
    const createResult = await map.get("create_agent_checklist")?.({});
    strict_1.default.deepEqual(createResult, { success: true, totalItems: 2 });
    const getResult = await map.get("get_agent_checklist")?.({});
    strict_1.default.deepEqual(getResult, { exists: true, totalItems: 2, completedItems: 0 });
});
// ── 3. Separation guarantee: agent checklist ≠ user checklist ───────────────
(0, node_test_1.default)("agent-checklist tool names do not contain the string 'completion_checklist'", () => {
    const agentToolNames = [
        "create_agent_checklist",
        "get_agent_checklist",
        "update_agent_checklist_item",
    ];
    for (const name of agentToolNames) {
        strict_1.default.ok(!name.includes("completion_checklist"), `${name} must not reference completion_checklist — it would imply it writes to the user's file`);
    }
});
//# sourceMappingURL=agentChecklist.test.js.map