import assert from "node:assert/strict";
import * as vscode from "vscode";

import { ToolRegistry } from "../../src/tools/toolRegistry";

const MACHINE_TOOLS = [
  "take_screenshot",
  "ocr_find_text",
  "list_windows",
  "focus_window",
  "launch_app",
  "gui_click",
  "gui_type",
  "gui_scroll",
  "gui_key",
  "gui_key_hold",
  "wait_for_condition",
];

suite("Machine interaction tools opt-in", () => {
  test("are always listed, but execution is blocked unless enableMachineInteractionTools=true", async () => {
    const output = vscode.window.createOutputChannel("local-qwen optin test");
    const registry = new ToolRegistry(output);

    const config = vscode.workspace.getConfiguration("localQwen");
    const original = config.get<boolean>("enableMachineInteractionTools", false);

    try {
      await config.update(
        "enableMachineInteractionTools",
        false,
        vscode.ConfigurationTarget.Workspace,
      );

      await registry.refresh();
      const disabledNames = registry.getExecutableTools().map((t) => t.name);
      for (const name of MACHINE_TOOLS) {
        assert.equal(
          disabledNames.includes(name),
          true,
          `Expected '${name}' to be listed even when disabled`,
        );
      }

      // Execution is blocked with a visible error.
      const disabledExec = (await registry.execute("take_screenshot", {})) as any;
      assert.equal(disabledExec.success, false);
      assert.ok(String(disabledExec.error).includes("enableMachineInteractionTools"));

      await config.update(
        "enableMachineInteractionTools",
        true,
        vscode.ConfigurationTarget.Workspace,
      );

      const enabledNames = registry.getExecutableTools().map((t) => t.name);
      // Still listed.
      assert.ok(enabledNames.includes("take_screenshot"));
      assert.ok(enabledNames.includes("gui_click"));
    } finally {
      await config.update(
        "enableMachineInteractionTools",
        original,
        vscode.ConfigurationTarget.Workspace,
      );
      output.dispose();
    }
  });
});
