"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_PROMPT_LAUNCH_PRIORITY_STEP = exports.SYSTEM_PROMPT_TERMINAL_FOCUS_STEP = exports.TERMINAL_FOCUS_COMMAND_GUIDANCE = void 0;
exports.collectToolNames = collectToolNames;
exports.getRuntimeInteractionCapabilities = getRuntimeInteractionCapabilities;
exports.hasMachineVerificationCapabilities = hasMachineVerificationCapabilities;
exports.buildMachineLaunchStrategyHintFromToolNames = buildMachineLaunchStrategyHintFromToolNames;
exports.TERMINAL_FOCUS_COMMAND_GUIDANCE = "In runtime verification flow, when run_vscode_command is available, focus terminal first using commandId=workbench.action.terminal.focus before run_in_terminal. Prefer await_terminal/get_terminal_output as the deterministic source of runtime state.";
exports.SYSTEM_PROMPT_TERMINAL_FOCUS_STEP = "  1) if run_vscode_command is available, bring terminal frontmost with commandId=workbench.action.terminal.focus,";
exports.SYSTEM_PROMPT_LAUNCH_PRIORITY_STEP = "  4) capture terminal screenshot, use ocr_find_text to locate served URL text, then choose launch path by available tools in this priority: gui_click URL coordinates → launch_app/localQwen_launch_app with served URL → run_vscode_command with commandId=vscode.open and args=[served URL],";
function collectToolNames(availableTools) {
    return availableTools.map((tool) => tool.function.name);
}
function getRuntimeInteractionCapabilities(toolNames) {
    const names = new Set(toolNames);
    return {
        supportsScreenshot: names.has("take_screenshot") || names.has("localQwen_take_screenshot"),
        supportsOcr: names.has("ocr_find_text") || names.has("localQwen_ocr_find_text"),
        supportsGuiClick: names.has("gui_click") || names.has("localQwen_gui_click"),
        supportsLaunchApp: names.has("launch_app") || names.has("localQwen_launch_app"),
        supportsVscodeOpen: names.has("run_vscode_command"),
    };
}
function hasMachineVerificationCapabilities(toolNames) {
    const capabilities = getRuntimeInteractionCapabilities(toolNames);
    return (capabilities.supportsScreenshot &&
        capabilities.supportsOcr &&
        (capabilities.supportsGuiClick ||
            capabilities.supportsLaunchApp ||
            capabilities.supportsVscodeOpen));
}
function buildMachineLaunchStrategyHintFromToolNames(toolNames) {
    const capabilities = getRuntimeInteractionCapabilities(toolNames);
    const paths = [];
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
//# sourceMappingURL=runtimeInteractionGuidance.js.map