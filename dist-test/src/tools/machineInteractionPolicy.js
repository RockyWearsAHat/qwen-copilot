"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MACHINE_INTERACTION_LM_TOOL_IDS = exports.MACHINE_INTERACTION_TOOL_NAMES = void 0;
exports.isMachineInteractionToolName = isMachineInteractionToolName;
exports.isMachineInteractionLmToolId = isMachineInteractionLmToolId;
exports.MACHINE_INTERACTION_TOOL_NAMES = new Set([
    // Vision / screenshot / OCR
    "take_screenshot",
    "ocr_find_text",
    // GUI input
    "gui_click",
    "gui_type",
    "gui_scroll",
    "gui_key",
    "gui_key_hold",
    // Window/process orchestration
    "list_windows",
    "focus_window",
    "launch_app",
    // Includes screen_contains which uses screenshot+OCR
    "wait_for_condition",
]);
exports.MACHINE_INTERACTION_LM_TOOL_IDS = new Set([
    "localQwen_take_screenshot",
    "localQwen_ocr_find_text",
    "localQwen_gui_click",
    "localQwen_gui_type",
    "localQwen_gui_scroll",
    "localQwen_gui_key",
    "localQwen_gui_key_hold",
    "localQwen_list_windows",
    "localQwen_focus_window",
    "localQwen_launch_app",
    "localQwen_wait_for_condition",
]);
function isMachineInteractionToolName(name) {
    return exports.MACHINE_INTERACTION_TOOL_NAMES.has(name);
}
function isMachineInteractionLmToolId(id) {
    return exports.MACHINE_INTERACTION_LM_TOOL_IDS.has(id);
}
//# sourceMappingURL=machineInteractionPolicy.js.map