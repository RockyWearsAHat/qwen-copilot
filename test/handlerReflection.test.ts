import test from "node:test";
import assert from "node:assert/strict";
import { reflectToolHandlers } from "../src/tools/handlerReflection";

test("reflectToolHandlers returns only tool_ function exports", async () => {
  const fakeModule = {
    tool_read_file: async (_args: Record<string, unknown>) => ({ ok: true }),
    tool_list_dir: async (_args: Record<string, unknown>) => ({ ok: true }),
    non_tool_value: 1,
    helper: () => "ignore",
  };

  const map = reflectToolHandlers(fakeModule);

  assert.equal(map.has("read_file"), true);
  assert.equal(map.has("list_dir"), true);
  assert.equal(map.has("helper"), false);

  const readFile = map.get("read_file");
  assert.ok(readFile);
  const result = await readFile?.({ filePath: "/tmp/a" });
  assert.deepEqual(result, { ok: true });
});
