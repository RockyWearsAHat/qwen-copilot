"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const toolSelector_1 = require("../src/tools/toolSelector");
function tool(name) {
    return { name, description: name, parameters: {} };
}
(0, node_test_1.default)("selectTools includes visual verification tools for runtime-error when available", () => {
    const intent = {
        type: "runtime-error",
        anchor: "FAILED TO LOAD GAME ASSETS",
        rawInput: "FAILED TO LOAD GAME ASSETS",
    };
    const allTools = [
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
    const selected = (0, toolSelector_1.selectTools)(intent, allTools, () => undefined, new Set());
    const names = new Set(selected.map((t) => t.name));
    strict_1.default.ok(names.has("take_screenshot"));
    strict_1.default.ok(names.has("ocr_find_text"));
    strict_1.default.ok(names.has("wait_for_condition"));
    strict_1.default.ok(names.has("launch_app"));
});
(0, node_test_1.default)("selectTools includes get_diagnostics for missing-resource", () => {
    const intent = {
        type: "missing-resource",
        anchor: "http://localhost:3000/PNG/explosion.png",
        rawInput: "GET http://localhost:3000/PNG/explosion.png 404",
    };
    const allTools = [
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
    const selected = (0, toolSelector_1.selectTools)(intent, allTools, () => undefined, new Set());
    const names = new Set(selected.map((t) => t.name));
    strict_1.default.ok(names.has("get_diagnostics"));
    strict_1.default.ok(names.has("http_request"));
    strict_1.default.ok(names.has("take_screenshot"));
    strict_1.default.ok(names.has("ocr_find_text"));
});
//# sourceMappingURL=toolSelector.test.js.map