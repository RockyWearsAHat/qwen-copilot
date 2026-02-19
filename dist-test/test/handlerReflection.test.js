"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const handlerReflection_1 = require("../src/tools/handlerReflection");
(0, node_test_1.default)("reflectToolHandlers returns only tool_ function exports", async () => {
    const fakeModule = {
        tool_read_file: async (_args) => ({ ok: true }),
        tool_list_dir: async (_args) => ({ ok: true }),
        non_tool_value: 1,
        helper: () => "ignore",
    };
    const map = (0, handlerReflection_1.reflectToolHandlers)(fakeModule);
    strict_1.default.equal(map.has("read_file"), true);
    strict_1.default.equal(map.has("list_dir"), true);
    strict_1.default.equal(map.has("helper"), false);
    const readFile = map.get("read_file");
    strict_1.default.ok(readFile);
    const result = await readFile?.({ filePath: "/tmp/a" });
    strict_1.default.deepEqual(result, { ok: true });
});
//# sourceMappingURL=handlerReflection.test.js.map