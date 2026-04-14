import test from "node:test";
import assert from "node:assert/strict";

import { selectTools } from "../src/tools/toolSelector";
import type { LockedIntent } from "../src/intent/intentExtractor";
import type { ToolDescriptor } from "../src/tools/toolRegistry";

function tool(name: string): ToolDescriptor {
  return { name, description: name, parameters: {} };
}

test("selectTools includes visual verification tools for runtime-error when available", () => {
  const intent: LockedIntent = {
    type: "runtime-error",
    anchor: "FAILED TO LOAD GAME ASSETS",
    rawInput: "FAILED TO LOAD GAME ASSETS",
  };

  const allTools: ToolDescriptor[] = [
    tool("read_file"),
    tool("file_search"),
    tool("grep_search"),
    tool("edit_file"),
    tool("run_in_terminal"),
    tool("get_diagnostics"),
    tool("take_screenshot"),
    tool("ocr_find_text"),
    tool("wait_for_condition"),
    tool("launch_app"),
  ];

  const selected = selectTools(intent, allTools, () => undefined, new Set());
  const names = new Set(selected.map((t) => t.name));

  assert.ok(names.has("take_screenshot"));
  assert.ok(names.has("ocr_find_text"));
  assert.ok(names.has("wait_for_condition"));
  assert.ok(names.has("launch_app"));
});

test("selectTools includes get_diagnostics for missing-resource", () => {
  const intent: LockedIntent = {
    type: "missing-resource",
    anchor: "http://localhost:3000/PNG/explosion.png",
    rawInput: "GET http://localhost:3000/PNG/explosion.png 404",
  };

  const allTools: ToolDescriptor[] = [
    tool("read_file"),
    tool("file_search"),
    tool("grep_search"),
    tool("edit_file"),
    tool("replace_in_files"),
    tool("http_request"),
    tool("get_diagnostics"),
    tool("take_screenshot"),
    tool("ocr_find_text"),
    tool("launch_app"),
    tool("wait_for_condition"),
  ];

  const selected = selectTools(intent, allTools, () => undefined, new Set());
  const names = new Set(selected.map((t) => t.name));

  assert.ok(names.has("get_diagnostics"));
  assert.ok(names.has("http_request"));
  assert.ok(names.has("take_screenshot"));
  assert.ok(names.has("ocr_find_text"));
});
