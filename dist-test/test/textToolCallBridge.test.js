"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const textToolCallBridge_1 = require("../src/agent/textToolCallBridge");
(0, node_test_1.default)("extractTaggedTextToolCalls extracts tool calls only when content is exclusively tagged JSON", () => {
    const allowedToolNames = new Set(["read_file"]);
    const result = (0, textToolCallBridge_1.extractTaggedTextToolCalls)({
        content: '<local_qwen_tool_call>{"tool_calls":[{"name":"read_file","arguments":{"filePath":"/tmp/a","startLine":1,"endLine":5}}]}</local_qwen_tool_call>',
        allowedToolNames,
        nextId: () => "id-1",
    });
    strict_1.default.equal(result.cleanedContent, "");
    strict_1.default.equal(result.toolCalls.length, 1);
    strict_1.default.equal(result.toolCalls[0].id, "id-1");
    strict_1.default.equal(result.toolCalls[0].function.name, "read_file");
    strict_1.default.deepEqual(result.toolCalls[0].function.arguments, {
        filePath: "/tmp/a",
        startLine: 1,
        endLine: 5,
    });
});
(0, node_test_1.default)("extractTaggedTextToolCalls rejects tagged JSON when extra prose exists", () => {
    const allowedToolNames = new Set(["read_file"]);
    const result = (0, textToolCallBridge_1.extractTaggedTextToolCalls)({
        content: 'Sure — I will read it now.\n<local_qwen_tool_call>{"tool_calls":[{"name":"read_file","arguments":{"filePath":"/tmp/a"}}]}</local_qwen_tool_call>',
        allowedToolNames,
        nextId: () => "id-1",
    });
    strict_1.default.equal(result.toolCalls.length, 1);
    strict_1.default.equal(result.toolCalls[0].function.name, "read_file");
    strict_1.default.ok(result.cleanedContent.includes("Sure"));
    strict_1.default.ok(!result.cleanedContent.includes("local_qwen_tool_call"));
});
(0, node_test_1.default)("extractTaggedTextToolCalls enforces allowlist", () => {
    const allowedToolNames = new Set(["read_file"]);
    const result = (0, textToolCallBridge_1.extractTaggedTextToolCalls)({
        content: '<local_qwen_tool_call>{"tool_calls":[{"name":"run_in_terminal","arguments":{"command":"rm -rf /"}}]}</local_qwen_tool_call>',
        allowedToolNames,
        nextId: () => "id-1",
    });
    strict_1.default.equal(result.cleanedContent, "");
    strict_1.default.equal(result.toolCalls.length, 1);
    strict_1.default.equal(result.toolCalls[0].function.name, "run_in_terminal");
    strict_1.default.deepEqual(result.toolCalls[0].function.arguments, { command: "rm -rf /" });
});
//# sourceMappingURL=textToolCallBridge.test.js.map