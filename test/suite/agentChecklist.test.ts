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

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import {
  tool_create_agent_checklist,
  tool_get_agent_checklist,
  tool_update_agent_checklist_item,
  tool_get_completion_checklist,
} from "../../src/tools/handlers";

// ── Helpers ──────────────────────────────────────────────────────────────────

function stubWorkspace(tmpDir: string): () => void {
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

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-checklist-test-"));
}

// ── Suite ────────────────────────────────────────────────────────────────────

suite("Two-Checklist System — handlers integration", () => {
  // Paths under the temp workspace
  let tmpDir: string;
  let restoreWorkspace: () => void;

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
    const result = (await tool_create_agent_checklist({
      title: "Test Work Plan",
      items: ["scaffold project", "write tests", "verify builds"],
    })) as Record<string, unknown>;

    assert.equal(result.success, true, "expected success");
    assert.ok(
      String(result.path ?? "").endsWith("agent-checklist.md"),
      `path should end with agent-checklist.md, got: ${result.path}`,
    );

    // agent-checklist.md must exist
    const agentPath = path.join(tmpDir, ".github", "agent-checklist.md");
    const content = await fs.readFile(agentPath, "utf-8");
    assert.ok(content.includes("- [ ] scaffold project"));
    assert.ok(content.includes("- [ ] write tests"));

    // completion-checklist.md must NOT exist
    const userPath = path.join(tmpDir, ".github", "completion-checklist.md");
    await assert.rejects(
      () => fs.access(userPath),
      "completion-checklist.md must not be created or touched by create_agent_checklist",
    );
  });

  test("create_agent_checklist rejects empty items array", async () => {
    const result = (await tool_create_agent_checklist({
      title: "Empty",
      items: [],
    })) as Record<string, unknown>;

    assert.equal(result.success, false);
  });

  // ── get_agent_checklist ────────────────────────────────────────────────────

  test("get_agent_checklist returns exists=false when no file present", async () => {
    const result = (await tool_get_agent_checklist({})) as Record<string, unknown>;
    assert.equal(result.exists, false);
  });

  test("get_agent_checklist parses items correctly after create", async () => {
    await tool_create_agent_checklist({
      title: "My Plan",
      items: ["step one", "step two", "step three"],
    });

    const result = (await tool_get_agent_checklist({})) as Record<string, unknown>;

    assert.equal(result.exists, true);
    assert.equal(result.totalItems, 3);
    assert.equal(result.completedItems, 0);
    assert.equal(result.allComplete, false);

    const items = result.items as Array<{ text: string; checked: boolean }>;
    assert.equal(items.length, 3);
    assert.equal(items[0].text, "step one");
    assert.equal(items[0].checked, false);
  });

  // ── update_agent_checklist_item ────────────────────────────────────────────

  test("update_agent_checklist_item marks an item done", async () => {
    await tool_create_agent_checklist({
      title: "Plan",
      items: ["scaffold project", "write controller"],
    });

    const updateResult = (await tool_update_agent_checklist_item({
      itemText: "scaffold",
      checked: true,
    })) as Record<string, unknown>;

    assert.equal(updateResult.success, true);

    const getResult = (await tool_get_agent_checklist({})) as Record<string, unknown>;
    const items = getResult.items as Array<{ text: string; checked: boolean }>;

    const scaffoldItem = items.find((i) => i.text.includes("scaffold"));
    assert.ok(scaffoldItem, "scaffold item not found");
    assert.equal(scaffoldItem.checked, true, "scaffold should be checked");

    const controllerItem = items.find((i) => i.text.includes("controller"));
    assert.ok(controllerItem, "controller item not found");
    assert.equal(controllerItem.checked, false, "controller should still be unchecked");
  });

  test("update_agent_checklist_item returns error for non-existent item", async () => {
    await tool_create_agent_checklist({
      title: "Plan",
      items: ["real task"],
    });

    const result = (await tool_update_agent_checklist_item({
      itemText: "this does not exist",
      checked: true,
    })) as Record<string, unknown>;

    assert.equal(result.success, false);
  });

  test("update_agent_checklist_item does NOT touch completion-checklist.md", async () => {
    // Pre-create the user's checklist manually.
    const githubDir = path.join(tmpDir, ".github");
    await fs.mkdir(githubDir, { recursive: true });
    const userChecklistPath = path.join(githubDir, "completion-checklist.md");
    const userContent = "# User Checklist\n\n- [ ] pass all tests\n";
    await fs.writeFile(userChecklistPath, userContent, "utf-8");

    // Create agent checklist and update an item.
    await tool_create_agent_checklist({ title: "Plan", items: ["do something"] });
    await tool_update_agent_checklist_item({ itemText: "do something", checked: true });

    // User's file must be exactly unchanged.
    const userContentAfter = await fs.readFile(userChecklistPath, "utf-8");
    assert.equal(
      userContentAfter,
      userContent,
      "completion-checklist.md was modified — that is forbidden",
    );
  });

  // ── get_completion_checklist (read-only guard) ─────────────────────────────

  test("get_completion_checklist reads user file without modifying it", async () => {
    const githubDir = path.join(tmpDir, ".github");
    await fs.mkdir(githubDir, { recursive: true });
    const userPath = path.join(githubDir, "completion-checklist.md");
    const original = "# Acceptance\n\n- [ ] feature works\n- [x] docs written\n";
    await fs.writeFile(userPath, original, "utf-8");

    const result = (await tool_get_completion_checklist({})) as Record<string, unknown>;

    assert.equal(result.exists, true);
    assert.equal(result.totalItems, 2);
    assert.equal(result.completedItems, 1);
    assert.equal(result.allComplete, false);

    // File must be byte-for-byte identical after the read.
    const after = await fs.readFile(userPath, "utf-8");
    assert.equal(after, original, "get_completion_checklist must not mutate the user's file");
  });

  test("get_completion_checklist returns exists=false when user has not created the file", async () => {
    const result = (await tool_get_completion_checklist({})) as Record<string, unknown>;
    assert.equal(result.exists, false);
  });

  // ── allComplete short-circuit ──────────────────────────────────────────────

  test("get_agent_checklist reports allComplete=true when every item is checked", async () => {
    await tool_create_agent_checklist({ title: "Short Plan", items: ["only task"] });
    await tool_update_agent_checklist_item({ itemText: "only task", checked: true });

    const result = (await tool_get_agent_checklist({})) as Record<string, unknown>;
    assert.equal(result.allComplete, true);
    assert.equal(result.completedItems, 1);
  });
});
