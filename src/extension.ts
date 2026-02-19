import * as vscode from "vscode";
import { LocalAgentRunner } from "./agent/localAgent";
import { LocalLanguageModelProvider } from "./llm/localLanguageModelProvider";
import { SmokeTestRunner } from "./testing/smokeTestRunner";
import { ToolRegistry } from "./tools/toolRegistry";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local Qwen Agent");
  const registry = new ToolRegistry(output);
  const runner = new LocalAgentRunner(registry, output);
  const modelProvider = new LocalLanguageModelProvider(output);
  const smokeTests = new SmokeTestRunner(output);

  const participant = vscode.chat.createChatParticipant(
    "localQwen.agent",
    async (request, _chatContext, stream, token) => {
      await runner.handleRequest(request, stream, token);
    },
  );

  participant.iconPath = new vscode.ThemeIcon("hubot");

  const refreshCommand = vscode.commands.registerCommand(
    "localQwen.refreshTools",
    async () => {
      await registry.refresh();
      const tools = registry.getExecutableTools();
      vscode.window.showInformationMessage(
        `Local Qwen Agent discovered ${tools.length} executable tools.`,
      );
    },
  );

  const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
    "local-ollama",
    modelProvider,
  );

  const runSmokeTestCommand = vscode.commands.registerCommand(
    "localQwen.runSmokeTest",
    async () => {
      try {
        output.show(true);
        output.appendLine("[local-qwen] running smoke test...");
        const result = await smokeTests.run();
        output.appendLine(
          `[local-qwen] smoke-test response: ${result.responsePreview}`,
        );

        vscode.window.showInformationMessage(
          `Smoke test passed with model '${result.modelUsed}'.`,
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[local-qwen] smoke-test failed: ${text}`);
        vscode.window.showErrorMessage(`Local Qwen smoke test failed: ${text}`);
      }
    },
  );

  const listLocalModelsCommand = vscode.commands.registerCommand(
    "localQwen.listLocalModels",
    async () => {
      try {
        const modelNames = await smokeTests.listModels();
        if (modelNames.length === 0) {
          vscode.window.showWarningMessage(
            "No local Ollama models discovered at the configured endpoint.",
          );
          return;
        }

        output.appendLine(
          `[local-qwen] discovered local models: ${modelNames.join(", ")}`,
        );
        vscode.window.showInformationMessage(
          `Local models: ${modelNames.join(", ")}`,
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[local-qwen] list models failed: ${text}`);
        vscode.window.showErrorMessage(
          `Unable to list local models: ${text}`,
        );
      }
    },
  );

  context.subscriptions.push(
    output,
    participant,
    refreshCommand,
    providerRegistration,
    runSmokeTestCommand,
    listLocalModelsCommand,
  );
}

export function deactivate(): void {
  // no-op
}
