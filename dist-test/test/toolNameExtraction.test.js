"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const toolNameExtraction_1 = require("../src/tools/toolNameExtraction");
(0, node_test_1.default)("extractToolNamesFromSource finds tool_ and functions.* patterns", () => {
    const source = `
    export async function tool_read_file() {}
    const x = functions.grep_search;
    const y = functions.run_in_terminal;
    const z = tool_list_dir;
  `;
    const names = (0, toolNameExtraction_1.extractToolNamesFromSource)(source);
    strict_1.default.deepEqual([...names].sort(), [
        "grep_search",
        "list_dir",
        "read_file",
        "run_in_terminal",
    ]);
});
(0, node_test_1.default)("extractToolNamesFromSource ignores unrelated symbols", () => {
    const source = `const notATool = foo.bar; function helper() {}`;
    const names = (0, toolNameExtraction_1.extractToolNamesFromSource)(source);
    strict_1.default.equal(names.size, 0);
});
//# sourceMappingURL=toolNameExtraction.test.js.map