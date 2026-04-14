import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../src/llm/provider/prompt/systemPrompt";

test("systemPrompt requires using only declared tool names", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Use ONLY tool names that appear in the provided tools list/i);
  assert.match(prompt, /do NOT call open_file; use read_file instead/i);
});

test("systemPrompt requires project-aware testing command selection", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /choose the project-appropriate command from workspace scripts\/config/i);
});

test("systemPrompt enforces batching independent read-only checks", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /emit them together in a single assistant turn as multiple tool calls/i);
});

test("systemPrompt forbids exploratory terminal commands before verification", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /verification command means app\/test\/build command from scripts\/config/i);
  assert.match(prompt, /it is never ls\/find\/tree\/grep\/cat/i);
});

test("systemPrompt defines ordered machine verification flow", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /commandId=workbench\.action\.terminal\.focus/i);
  assert.match(prompt, /focus_window to bring the terminal window to foreground before OCR/i);
  assert.match(prompt, /ocr_find_text to locate served URL text/i);
  assert.match(prompt, /gui_click URL coordinates/i);
  assert.match(
    prompt,
    /launch_app\/localQwen_launch_app with served URL → run_vscode_command with commandId=vscode.open/i,
  );
  assert.match(prompt, /gui_key\/gui_type\/gui_click/i);
  assert.match(prompt, /take_screenshot, then parse\/verify using ocr_find_text or analyze_image/i);
  assert.match(prompt, /ls\/find\/tree\/grep\/cat cannot confirm runtime behavior/i);
});

test("systemPrompt fallback verification does not rely on open_simple_browser", () => {
  const prompt = buildSystemPrompt();
  assert.doesNotMatch(prompt, /open_simple_browser http:\/\/localhost:3000/i);
  assert.match(
    prompt,
    /run get_errors \(or relevant diagnostics\) to confirm no immediate failures remain/i,
  );
});

test("systemPrompt defines machine verification philosophy as natural tool guidance", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /tell you whether a runtime error is real or stale/i);
  assert.match(prompt, /no amount of file reading can substitute/i);
  assert.match(prompt, /Anti-pattern.*list_dir.*read_file.*grep_search/i);
});
