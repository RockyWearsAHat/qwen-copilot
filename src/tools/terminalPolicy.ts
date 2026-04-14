/**
 * Terminal policy: intentionally permissive.
 *
 * This project aims to avoid hidden guardrails that make the model appear "dumber".
 * If a terminal command is a bad idea, we want that to be solved via prompting and
 * observable behavior (errors/output), not silent blocks.
 */
type VerificationTerminalPolicy = {
  active: boolean;
  expectedCommand: string;
};

let verificationPolicy: VerificationTerminalPolicy = {
  active: false,
  expectedCommand: "",
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const EXPLORATORY_SHELL_PATTERN =
  /(^|\s)(ls|find|grep|egrep|fgrep|rg|ripgrep|fd|tree|du|wc|head|tail|awk|sed|xargs|locate)(\s|$)/i;

export function setVerificationTerminalPolicy(expectedCommand: string): void {
  verificationPolicy = {
    active: true,
    expectedCommand: normalize(expectedCommand),
  };
}

export function clearVerificationTerminalPolicy(): void {
  verificationPolicy = {
    active: false,
    expectedCommand: "",
  };
}

export function getTerminalPolicyViolation(command: string): string | null {
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
