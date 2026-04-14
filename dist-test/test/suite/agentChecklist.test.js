"use strict";
/**
 * VS Code-environment integration tests for the two-checklist system.
 *
 * Verifies:
 *  - `create_agent_checklist` writes to `.github/agent-checklist.md` only.
 *  - `get_agent_checklist` parses it correctly.
 *  - `update_agent_checklist_item` marks items without touching any other file.
 *  - The user's `.github/completion-checklist.md` is NEVER modified by any
 *    agent-checklist operation.
 */
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const vscode = __importStar(require("vscode"));
const handlers_1 = require("../../src/tools/handlers");
// ── Helpers ──────────────────────────────────────────────────────────────────
function stubWorkspace(tmpDir) {
    const original = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        value: [{ uri: vscode.Uri.file(tmpDir), name: "test", index: 0 }],
    });
    return () => {
        if (original) {
            Object.defineProperty(vscode.workspace, "workspaceFolders", original);
        }
    };
}
async function makeTempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "agent-checklist-test-"));
}
// ── Suite ────────────────────────────────────────────────────────────────────
suite("Two-Checklist System — handlers integration", () => {
    // Paths under the temp workspace
    let tmpDir;
    let restoreWorkspace;
    setup(async () => {
        tmpDir = await makeTempDir();
        restoreWorkspace = stubWorkspace(tmpDir);
    });
    teardown(async () => {
        restoreWorkspace();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });
    // ── create_agent_checklist ─────────────────────────────────────────────────
    test("create_agent_checklist writes to agent-checklist.md, not completion-checklist.md", async () => {
        const result = (await (0, handlers_1.tool_create_agent_checklist)({
            title: "Test Work Plan",
            items: ["scaffold project", "write tests", "verify builds"],
        }));
        strict_1.default.equal(result.success, true, "expected success");
        strict_1.default.ok(String(result.path ?? "").endsWith("agent-checklist.md"), `path should end with agent-checklist.md, got: ${result.path}`);
        // agent-checklist.md must exist
        const agentPath = path.join(tmpDir, ".github", "agent-checklist.md");
        const content = await fs.readFile(agentPath, "utf-8");
        strict_1.default.ok(content.includes("- [ ] scaffold project"));
        strict_1.default.ok(content.includes("- [ ] write tests"));
        // completion-checklist.md must NOT exist
        const userPath = path.join(tmpDir, ".github", "completion-checklist.md");
        await strict_1.default.rejects(() => fs.access(userPath), "completion-checklist.md must not be created or touched by create_agent_checklist");
    });
    test("create_agent_checklist rejects empty items array", async () => {
        const result = (await (0, handlers_1.tool_create_agent_checklist)({
            title: "Empty",
            items: [],
        }));
        strict_1.default.equal(result.success, false);
    });
    // ── get_agent_checklist ────────────────────────────────────────────────────
    test("get_agent_checklist returns exists=false when no file present", async () => {
        const result = (await (0, handlers_1.tool_get_agent_checklist)({}));
        strict_1.default.equal(result.exists, false);
    });
    test("get_agent_checklist parses items correctly after create", async () => {
        await (0, handlers_1.tool_create_agent_checklist)({
            title: "My Plan",
            items: ["step one", "step two", "step three"],
        });
        const result = (await (0, handlers_1.tool_get_agent_checklist)({}));
        strict_1.default.equal(result.exists, true);
        strict_1.default.equal(result.totalItems, 3);
        strict_1.default.equal(result.completedItems, 0);
        strict_1.default.equal(result.allComplete, false);
        const items = result.items;
        strict_1.default.equal(items.length, 3);
        strict_1.default.equal(items[0].text, "step one");
        strict_1.default.equal(items[0].checked, false);
    });
    // ── update_agent_checklist_item ────────────────────────────────────────────
    test("update_agent_checklist_item marks an item done", async () => {
        await (0, handlers_1.tool_create_agent_checklist)({
            title: "Plan",
            items: ["scaffold project", "write controller"],
        });
        const updateResult = (await (0, handlers_1.tool_update_agent_checklist_item)({
            itemText: "scaffold",
            checked: true,
        }));
        strict_1.default.equal(updateResult.success, true);
        const getResult = (await (0, handlers_1.tool_get_agent_checklist)({}));
        const items = getResult.items;
        const scaffoldItem = items.find((i) => i.text.includes("scaffold"));
        strict_1.default.ok(scaffoldItem, "scaffold item not found");
        strict_1.default.equal(scaffoldItem.checked, true, "scaffold should be checked");
        const controllerItem = items.find((i) => i.text.includes("controller"));
        strict_1.default.ok(controllerItem, "controller item not found");
        strict_1.default.equal(controllerItem.checked, false, "controller should still be unchecked");
    });
    test("update_agent_checklist_item returns error for non-existent item", async () => {
        await (0, handlers_1.tool_create_agent_checklist)({
            title: "Plan",
            items: ["real task"],
        });
        const result = (await (0, handlers_1.tool_update_agent_checklist_item)({
            itemText: "this does not exist",
            checked: true,
        }));
        strict_1.default.equal(result.success, false);
    });
    test("update_agent_checklist_item does NOT touch completion-checklist.md", async () => {
        // Pre-create the user's checklist manually.
        const githubDir = path.join(tmpDir, ".github");
        await fs.mkdir(githubDir, { recursive: true });
        const userChecklistPath = path.join(githubDir, "completion-checklist.md");
        const userContent = "# User Checklist\n\n- [ ] pass all tests\n";
        await fs.writeFile(userChecklistPath, userContent, "utf-8");
        // Create agent checklist and update an item.
        await (0, handlers_1.tool_create_agent_checklist)({ title: "Plan", items: ["do something"] });
        await (0, handlers_1.tool_update_agent_checklist_item)({ itemText: "do something", checked: true });
        // User's file must be exactly unchanged.
        const userContentAfter = await fs.readFile(userChecklistPath, "utf-8");
        strict_1.default.equal(userContentAfter, userContent, "completion-checklist.md was modified — that is forbidden");
    });
    // ── get_completion_checklist (read-only guard) ─────────────────────────────
    test("get_completion_checklist reads user file without modifying it", async () => {
        const githubDir = path.join(tmpDir, ".github");
        await fs.mkdir(githubDir, { recursive: true });
        const userPath = path.join(githubDir, "completion-checklist.md");
        const original = "# Acceptance\n\n- [ ] feature works\n- [x] docs written\n";
        await fs.writeFile(userPath, original, "utf-8");
        const result = (await (0, handlers_1.tool_get_completion_checklist)({}));
        strict_1.default.equal(result.exists, true);
        strict_1.default.equal(result.totalItems, 2);
        strict_1.default.equal(result.completedItems, 1);
        strict_1.default.equal(result.allComplete, false);
        // File must be byte-for-byte identical after the read.
        const after = await fs.readFile(userPath, "utf-8");
        strict_1.default.equal(after, original, "get_completion_checklist must not mutate the user's file");
    });
    test("get_completion_checklist returns exists=false when user has not created the file", async () => {
        const result = (await (0, handlers_1.tool_get_completion_checklist)({}));
        strict_1.default.equal(result.exists, false);
    });
    // ── allComplete short-circuit ──────────────────────────────────────────────
    test("get_agent_checklist reports allComplete=true when every item is checked", async () => {
        await (0, handlers_1.tool_create_agent_checklist)({ title: "Short Plan", items: ["only task"] });
        await (0, handlers_1.tool_update_agent_checklist_item)({ itemText: "only task", checked: true });
        const result = (await (0, handlers_1.tool_get_agent_checklist)({}));
        strict_1.default.equal(result.allComplete, true);
        strict_1.default.equal(result.completedItems, 1);
    });
});
//# sourceMappingURL=agentChecklist.test.js.map