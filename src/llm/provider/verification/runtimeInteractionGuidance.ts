import type { LlmToolSpec } from "../../ollamaClient";

export const TERMINAL_FOCUS_COMMAND_GUIDANCE =
  "In runtime verification flow, when run_vscode_command is available, focus terminal first using commandId=workbench.action.terminal.focus before run_in_terminal. Prefer await_terminal/get_terminal_output as the deterministic source of runtime state.";

export const SYSTEM_PROMPT_TERMINAL_FOCUS_STEP =
  "  1) if run_vscode_command is available, bring terminal frontmost with commandId=workbench.action.terminal.focus,";

export const SYSTEM_PROMPT_LAUNCH_PRIORITY_STEP =
  "  4) capture terminal screenshot, use ocr_find_text to locate served URL text, then choose launch path by available tools in this priority: gui_click URL coordinates → launch_app/localQwen_launch_app with served URL → run_vscode_command with commandId=vscode.open and args=[served URL],";

export interface RuntimeInteractionCapabilities {
  supportsScreenshot: boolean;
  supportsOcr: boolean;
  supportsGuiClick: boolean;
  supportsLaunchApp: boolean;
  supportsVscodeOpen: boolean;
}

export function collectToolNames(availableTools: readonly LlmToolSpec[]): string[] {
  return availableTools.map((tool) => tool.function.name);
}

export function getRuntimeInteractionCapabilities(
  toolNames: readonly string[],
): RuntimeInteractionCapabilities {
  const names = new Set(toolNames);
  return {
    supportsScreenshot: names.has("take_screenshot") || names.has("localQwen_take_screenshot"),
    supportsOcr: names.has("ocr_find_text") || names.has("localQwen_ocr_find_text"),
    supportsGuiClick: names.has("gui_click") || names.has("localQwen_gui_click"),
    supportsLaunchApp: names.has("launch_app") || names.has("localQwen_launch_app"),
    supportsVscodeOpen: names.has("run_vscode_command"),
  };
}

export function hasMachineVerificationCapabilities(toolNames: readonly string[]): boolean {
  const capabilities = getRuntimeInteractionCapabilities(toolNames);
  return (
    capabilities.supportsScreenshot &&
    capabilities.supportsOcr &&
    (capabilities.supportsGuiClick ||
      capabilities.supportsLaunchApp ||
      capabilities.supportsVscodeOpen)
  );
}

export function buildMachineLaunchStrategyHintFromToolNames(toolNames: readonly string[]): string {
  const capabilities = getRuntimeInteractionCapabilities(toolNames);
  const paths: string[] = [];

  if (capabilities.supportsGuiClick) {
    paths.push("prefer OCR URL text → gui_click coordinates");
  }
  if (capabilities.supportsLaunchApp) {
    paths.push("fallback launch_app/localQwen_launch_app with served URL");
  }
  if (capabilities.supportsVscodeOpen) {
    paths.push("fallback run_vscode_command (commandId=vscode.open, args=[served URL])");
  }

  if (paths.length === 0) {
    return "no direct launch tool in this turn; ask user to open the served URL in system browser";
  }

  return paths.join("; ");
}
