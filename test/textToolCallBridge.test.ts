import test from "node:test";
import assert from "node:assert/strict";
import { extractTaggedTextToolCalls } from "../src/agent/textToolCallBridge";

test("extractTaggedTextToolCalls extracts tool calls only when content is exclusively tagged JSON", () => {
  const allowedToolNames = new Set(["read_file"]);
  const result = extractTaggedTextToolCalls({
    content:
      '<local_qwen_tool_call>{"tool_calls":[{"name":"read_file","arguments":{"filePath":"/tmp/a","startLine":1,"endLine":5}}]}</local_qwen_tool_call>',
    allowedToolNames,
    nextId: () => "id-1",
  });

  assert.equal(result.cleanedContent, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "id-1");
  assert.equal(result.toolCalls[0].function.name, "read_file");
  assert.deepEqual(result.toolCalls[0].function.arguments, {
    filePath: "/tmp/a",
    startLine: 1,
    endLine: 5,
  });
});

test("extractTaggedTextToolCalls rejects tagged JSON when extra prose exists", () => {
  const allowedToolNames = new Set(["read_file"]);
  const result = extractTaggedTextToolCalls({
    content:
      'Sure — I will read it now.\n<local_qwen_tool_call>{"tool_calls":[{"name":"read_file","arguments":{"filePath":"/tmp/a"}}]}</local_qwen_tool_call>',
    allowedToolNames,
    nextId: () => "id-1",
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "read_file");
  assert.ok(result.cleanedContent.includes("Sure"));
  assert.ok(!result.cleanedContent.includes("local_qwen_tool_call"));
});

test("extractTaggedTextToolCalls enforces allowlist", () => {
  const allowedToolNames = new Set(["read_file"]);
  const result = extractTaggedTextToolCalls({
    content:
      '<local_qwen_tool_call>{"tool_calls":[{"name":"run_in_terminal","arguments":{"command":"rm -rf /"}}]}</local_qwen_tool_call>',
    allowedToolNames,
    nextId: () => "id-1",
  });

  assert.equal(result.cleanedContent, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "run_in_terminal");
  assert.deepEqual(result.toolCalls[0].function.arguments, { command: "rm -rf /" });
});
