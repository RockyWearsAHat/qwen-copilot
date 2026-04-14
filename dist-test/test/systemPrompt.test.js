"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const systemPrompt_1 = require("../src/llm/provider/prompt/systemPrompt");
(0, node_test_1.default)("systemPrompt requires using only declared tool names", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.match(prompt, /Use ONLY tool names that appear in the provided tools list/i);
    strict_1.default.match(prompt, /do NOT call open_file; use read_file instead/i);
});
(0, node_test_1.default)("systemPrompt requires project-aware testing command selection", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.match(prompt, /choose the project-appropriate command from workspace scripts\/config/i);
});
(0, node_test_1.default)("systemPrompt enforces batching independent read-only checks", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.match(prompt, /emit them together in a single assistant turn as multiple tool calls/i);
});
(0, node_test_1.default)("systemPrompt forbids exploratory terminal commands before verification", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.match(prompt, /verification command means app\/test\/build command from scripts\/config/i);
    strict_1.default.match(prompt, /it is never ls\/find\/tree\/grep\/cat/i);
});
(0, node_test_1.default)("systemPrompt defines ordered machine verification flow", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.match(prompt, /commandId=workbench\.action\.terminal\.focus/i);
    strict_1.default.match(prompt, /focus_window to bring the terminal window to foreground before OCR/i);
    strict_1.default.match(prompt, /ocr_find_text to locate served URL text/i);
    strict_1.default.match(prompt, /gui_click URL coordinates/i);
    strict_1.default.match(prompt, /launch_app\/localQwen_launch_app with served URL → run_vscode_command with commandId=vscode.open/i);
    strict_1.default.match(prompt, /gui_key\/gui_type\/gui_click/i);
    strict_1.default.match(prompt, /take_screenshot, then parse\/verify using ocr_find_text or analyze_image/i);
    strict_1.default.match(prompt, /ls\/find\/tree\/grep\/cat cannot confirm runtime behavior/i);
});
(0, node_test_1.default)("systemPrompt fallback verification does not rely on open_simple_browser", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.doesNotMatch(prompt, /open_simple_browser http:\/\/localhost:3000/i);
    strict_1.default.match(prompt, /run get_errors \(or relevant diagnostics\) to confirm no immediate failures remain/i);
});
(0, node_test_1.default)("systemPrompt defines machine verification philosophy as natural tool guidance", () => {
    const prompt = (0, systemPrompt_1.buildSystemPrompt)();
    strict_1.default.match(prompt, /tell you whether a runtime error is real or stale/i);
    strict_1.default.match(prompt, /no amount of file reading can substitute/i);
    strict_1.default.match(prompt, /Anti-pattern.*list_dir.*read_file.*grep_search/i);
});
//# sourceMappingURL=systemPrompt.test.js.map