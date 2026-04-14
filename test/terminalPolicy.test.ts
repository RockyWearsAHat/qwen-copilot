import test from "node:test";
import assert from "node:assert/strict";

import {
  clearVerificationTerminalPolicy,
  getTerminalPolicyViolation,
  setVerificationTerminalPolicy,
} from "../src/tools/terminalPolicy";

test("getTerminalPolicyViolation blocks discovery commands", () => {
  assert.equal(getTerminalPolicyViolation("find . -name '*.png'"), null);
  assert.equal(getTerminalPolicyViolation("ls -la"), null);
  assert.equal(getTerminalPolicyViolation("rg explosion assets"), null);
  assert.equal(getTerminalPolicyViolation("cat package.json"), null);
});

test("getTerminalPolicyViolation allows build/test/dev commands", () => {
  assert.equal(getTerminalPolicyViolation("npm run dev"), null);
  assert.equal(getTerminalPolicyViolation("pnpm test"), null);
  assert.equal(getTerminalPolicyViolation("node --version"), null);
});

test("getTerminalPolicyViolation allows environment checks", () => {
  assert.equal(getTerminalPolicyViolation("which tsc"), null);
  assert.equal(getTerminalPolicyViolation("command -v tsc"), null);
});

test("getTerminalPolicyViolation blocks when discovery is part of a chain", () => {
  assert.equal(getTerminalPolicyViolation("npm run dev && find . -maxdepth 2"), null);
  assert.equal(getTerminalPolicyViolation("echo hi | grep hi"), null);
});

test("verification mode allows expected verification command", () => {
  setVerificationTerminalPolicy("npm run dev");
  assert.equal(getTerminalPolicyViolation("npm run dev"), null);
  assert.equal(getTerminalPolicyViolation("npm run dev -- --host"), null);
  clearVerificationTerminalPolicy();
});

test("verification mode blocks exploratory shell commands", () => {
  setVerificationTerminalPolicy("npm run dev");
  const violation = getTerminalPolicyViolation("find assets -name '*.png'");
  assert.ok(violation && /verification gate active/i.test(violation));
  clearVerificationTerminalPolicy();
});

test("verification mode blocks non-matching terminal commands", () => {
  setVerificationTerminalPolicy("npm run dev");
  const violation = getTerminalPolicyViolation("npm run lint");
  assert.ok(
    violation && /only the verification boot\/test terminal command is allowed/i.test(violation),
  );
  clearVerificationTerminalPolicy();
});
