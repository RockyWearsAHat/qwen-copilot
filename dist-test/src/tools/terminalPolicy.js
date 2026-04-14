"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setVerificationTerminalPolicy = setVerificationTerminalPolicy;
exports.clearVerificationTerminalPolicy = clearVerificationTerminalPolicy;
exports.getTerminalPolicyViolation = getTerminalPolicyViolation;
let verificationPolicy = {
    active: false,
    expectedCommand: "",
};
function normalize(value) {
    return value.trim().toLowerCase();
}
const EXPLORATORY_SHELL_PATTERN = /(^|\s)(ls|find|grep|egrep|fgrep|rg|ripgrep|fd|tree|du|wc|head|tail|awk|sed|xargs|locate)(\s|$)/i;
function setVerificationTerminalPolicy(expectedCommand) {
    verificationPolicy = {
        active: true,
        expectedCommand: normalize(expectedCommand),
    };
}
function clearVerificationTerminalPolicy() {
    verificationPolicy = {
        active: false,
        expectedCommand: "",
    };
}
function getTerminalPolicyViolation(command) {
    if (!verificationPolicy.active) {
        return null;
    }
    const normalizedCommand = normalize(command);
    if (!normalizedCommand) {
        return null;
    }
    if (verificationPolicy.expectedCommand) {
        if (normalizedCommand === verificationPolicy.expectedCommand) {
            return null;
        }
        if (normalizedCommand.startsWith(verificationPolicy.expectedCommand + " ")) {
            return null;
        }
    }
    if (EXPLORATORY_SHELL_PATTERN.test(normalizedCommand)) {
        return `Verification gate active: terminal command blocked. Run the verification command first: ${verificationPolicy.expectedCommand}`;
    }
    return `Verification gate active: only the verification boot/test terminal command is allowed right now: ${verificationPolicy.expectedCommand}`;
}
//# sourceMappingURL=terminalPolicy.js.map