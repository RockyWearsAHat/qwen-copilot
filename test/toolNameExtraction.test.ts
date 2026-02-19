import test from "node:test";
import assert from "node:assert/strict";
import { extractToolNamesFromSource } from "../src/tools/toolNameExtraction";

test("extractToolNamesFromSource finds tool_ and functions.* patterns", () => {
  const source = `
    export async function tool_read_file() {}
    const x = functions.grep_search;
    const y = functions.run_in_terminal;
    const z = tool_list_dir;
  `;

  const names = extractToolNamesFromSource(source);

  assert.deepEqual([...names].sort(), [
    "grep_search",
    "list_dir",
    "read_file",
    "run_in_terminal",
  ]);
});

test("extractToolNamesFromSource ignores unrelated symbols", () => {
  const source = `const notATool = foo.bar; function helper() {}`;
  const names = extractToolNamesFromSource(source);
  assert.equal(names.size, 0);
});
