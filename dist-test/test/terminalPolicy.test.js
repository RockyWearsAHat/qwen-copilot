"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const terminalPolicy_1 = require("../src/tools/terminalPolicy");
(0, node_test_1.default)("getTerminalPolicyViolation blocks discovery commands", () => {
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("find . -name '*.png'"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("ls -la"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("rg explosion assets"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("cat package.json"), null);
});
(0, node_test_1.default)("getTerminalPolicyViolation allows build/test/dev commands", () => {
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("npm run dev"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("pnpm test"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("node --version"), null);
});
(0, node_test_1.default)("getTerminalPolicyViolation allows environment checks", () => {
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("which tsc"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("command -v tsc"), null);
});
(0, node_test_1.default)("getTerminalPolicyViolation blocks when discovery is part of a chain", () => {
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("npm run dev && find . -maxdepth 2"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("echo hi | grep hi"), null);
});
(0, node_test_1.default)("verification mode allows expected verification command", () => {
    (0, terminalPolicy_1.setVerificationTerminalPolicy)("npm run dev");
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("npm run dev"), null);
    strict_1.default.equal((0, terminalPolicy_1.getTerminalPolicyViolation)("npm run dev -- --host"), null);
    (0, terminalPolicy_1.clearVerificationTerminalPolicy)();
});
(0, node_test_1.default)("verification mode blocks exploratory shell commands", () => {
    (0, terminalPolicy_1.setVerificationTerminalPolicy)("npm run dev");
    const violation = (0, terminalPolicy_1.getTerminalPolicyViolation)("find assets -name '*.png'");
    strict_1.default.ok(violation && /verification gate active/i.test(violation));
    (0, terminalPolicy_1.clearVerificationTerminalPolicy)();
});
(0, node_test_1.default)("verification mode blocks non-matching terminal commands", () => {
    (0, terminalPolicy_1.setVerificationTerminalPolicy)("npm run dev");
    const violation = (0, terminalPolicy_1.getTerminalPolicyViolation)("npm run lint");
    strict_1.default.ok(violation && /only the verification boot\/test terminal command is allowed/i.test(violation));
    (0, terminalPolicy_1.clearVerificationTerminalPolicy)();
});
//# sourceMappingURL=terminalPolicy.test.js.map