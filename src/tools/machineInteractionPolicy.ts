export const MACHINE_INTERACTION_TOOL_NAMES = new Set<string>([
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

export const MACHINE_INTERACTION_LM_TOOL_IDS = new Set<string>([
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

export function isMachineInteractionToolName(name: string): boolean {
  return MACHINE_INTERACTION_TOOL_NAMES.has(name);
}

export function isMachineInteractionLmToolId(id: string): boolean {
  return MACHINE_INTERACTION_LM_TOOL_IDS.has(id);
}
