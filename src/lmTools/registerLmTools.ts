import * as vscode from "vscode";
import {
  tool_analyze_image,
  tool_focus_window,
  tool_gui_click,
  tool_gui_key,
  tool_gui_key_hold,
  tool_gui_scroll,
  tool_gui_type,
  tool_launch_app,
  tool_list_windows,
  tool_ocr_find_text,
  tool_take_screenshot,
  tool_wait_for_condition,
} from "../tools/handlers";

function asJsonResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([vscode.LanguageModelDataPart.json(value)]);
}

function asTextResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function requireConfirmation(title: string, body: string): vscode.PreparedToolInvocation {
  return {
    confirmationMessages: {
      title,
      message: new vscode.MarkdownString(body),
    },
  };
}

export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): void {
  const tools: Array<vscode.Disposable> = [];

  const configuration = vscode.workspace.getConfiguration("localQwen");
  const machineToolsEnabled = configuration.get<boolean>("enableMachineInteractionTools", false);

  const machineToolsDisabledResult = (toolId: string): vscode.LanguageModelToolResult =>
    asJsonResult({
      success: false,
      error: `Tool '${toolId}' is disabled. Enable localQwen.enableMachineInteractionTools to allow screenshot/OCR/GUI interaction tools.`,
    });

  tools.push(
    vscode.lm.registerTool("localQwen_take_screenshot", {
      prepareInvocation: ({ input }) => {
        const typed = input as { windowTitle?: string; region?: unknown; delay?: number };
        const details = [
          typed.windowTitle ? `windowTitle=\"${typed.windowTitle}\"` : "full screen",
          typed.region ? "region=…" : "",
          typeof typed.delay === "number" && typed.delay > 0 ? `delay=${typed.delay}s` : "",
        ]
          .filter(Boolean)
          .join(", ");
        return { invocationMessage: `Capturing screenshot (${details})…` };
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_take_screenshot");
        }

        const result = (await tool_take_screenshot(input as Record<string, unknown>)) as any;
        if (!result?.success || !result?.image) {
          return asJsonResult(result);
        }

        const buffer = Buffer.from(String(result.image), "base64");
        const meta = {
          format: result.format,
          sizeBytes: result.sizeBytes,
          meta: result.meta,
        };

        return new vscode.LanguageModelToolResult([
          vscode.LanguageModelDataPart.image(new Uint8Array(buffer), "image/png"),
          vscode.LanguageModelDataPart.json(meta),
        ]);
      },
    }),
  );

  if (!machineToolsEnabled) {
    output.appendLine(
      "[local-qwen] machine interaction tools are disabled (localQwen.enableMachineInteractionTools=false); machine LM tools are registered but will return a disabled error until enabled.",
    );
  }

  tools.push(
    vscode.lm.registerTool("localQwen_analyze_image", {
      prepareInvocation: () => ({ invocationMessage: "Analyzing image…" }),
      invoke: async ({ input }) => {
        const result = await tool_analyze_image(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_ocr_find_text", {
      prepareInvocation: ({ input }) => {
        const typed = input as { query?: string };
        return { invocationMessage: `Running OCR for: ${typed.query ?? "(unknown)"}` };
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_ocr_find_text");
        }
        const result = await tool_ocr_find_text(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_list_windows", {
      prepareInvocation: () => ({ invocationMessage: "Listing windows…" }),
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_list_windows");
        }
        const result = await tool_list_windows(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_focus_window", {
      prepareInvocation: ({ input }) => {
        const typed = input as { windowTitle?: string };
        return requireConfirmation(
          "Focus window",
          `Bring a window matching **${typed.windowTitle ?? "(unknown)"}** to the foreground?`,
        );
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_focus_window");
        }
        const result = await tool_focus_window(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_launch_app", {
      prepareInvocation: ({ input }) => {
        const typed = input as { target?: string; args?: string[] };
        const args =
          Array.isArray(typed.args) && typed.args.length > 0 ? ` ${typed.args.join(" ")}` : "";
        return requireConfirmation(
          "Launch app or URL",
          `Launch **${typed.target ?? "(unknown)"}**${args}?`,
        );
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_launch_app");
        }
        const result = await tool_launch_app(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_gui_click", {
      prepareInvocation: ({ input }) => {
        const typed = input as { x?: number; y?: number; button?: string; doubleClick?: boolean };
        return requireConfirmation(
          "GUI click",
          `Click at (**${typed.x ?? "?"}**, **${typed.y ?? "?"}**) with **${typed.button ?? "left"}**${typed.doubleClick ? " (double)" : ""}?`,
        );
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_gui_click");
        }
        const result = await tool_gui_click(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_gui_type", {
      prepareInvocation: ({ input }) => {
        const typed = input as { text?: string };
        const preview = (typed.text ?? "").slice(0, 80);
        return requireConfirmation(
          "GUI type",
          `Type: \`${preview}\`${(typed.text ?? "").length > 80 ? "…" : ""}?`,
        );
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_gui_type");
        }
        const result = await tool_gui_type(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_gui_scroll", {
      prepareInvocation: ({ input }) => {
        const typed = input as { x?: number; y?: number; direction?: string; amount?: number };
        return requireConfirmation(
          "GUI scroll",
          `Scroll **${typed.direction ?? "down"}** at (**${typed.x ?? "?"}**, **${typed.y ?? "?"}**) amount=${typed.amount ?? 3}?`,
        );
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_gui_scroll");
        }
        const result = await tool_gui_scroll(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_gui_key", {
      prepareInvocation: ({ input }) => {
        const typed = input as { key?: string; modifiers?: string[] };
        const combo = `${Array.isArray(typed.modifiers) && typed.modifiers.length > 0 ? typed.modifiers.join("+") + "+" : ""}${typed.key ?? ""}`;
        return requireConfirmation("GUI key press", `Press **${combo || "(unknown)"}**?`);
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_gui_key");
        }
        const result = await tool_gui_key(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_gui_key_hold", {
      prepareInvocation: ({ input }) => {
        const typed = input as { key?: string; durationMs?: number };
        return requireConfirmation(
          "GUI key hold",
          `Hold **${typed.key ?? "(unknown)"}** for **${typed.durationMs ?? 300}ms**?`,
        );
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_gui_key_hold");
        }
        const result = await tool_gui_key_hold(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  tools.push(
    vscode.lm.registerTool("localQwen_wait_for_condition", {
      prepareInvocation: ({ input }) => {
        const typed = input as { type?: string; target?: string; timeout?: number };
        return { invocationMessage: `Waiting for condition: ${typed.type ?? "(unknown)"}` };
      },
      invoke: async ({ input }) => {
        const latestEnabled = vscode.workspace
          .getConfiguration("localQwen")
          .get<boolean>("enableMachineInteractionTools", false);
        if (!latestEnabled) {
          return machineToolsDisabledResult("localQwen_wait_for_condition");
        }
        const result = await tool_wait_for_condition(input as Record<string, unknown>);
        return asJsonResult(result);
      },
    }),
  );

  for (const disposable of tools) {
    context.subscriptions.push(disposable);
  }

  output.appendLine(`[local-qwen] registered ${tools.length} language-model tools.`);
}
