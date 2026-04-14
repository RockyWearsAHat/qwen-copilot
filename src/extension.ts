import * as vscode from "vscode";
import { LocalAgentRunner } from "./agent/localAgent";
import { LocalLanguageModelProvider } from "./llm/localLanguageModelProvider";
import { SmokeTestRunner } from "./testing/smokeTestRunner";
import { ToolRegistry } from "./tools/toolRegistry";
import { cleanupBackgroundProcesses } from "./tools/handlers";
import { registerLanguageModelTools } from "./lmTools/registerLmTools";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local Copilot Agents");
  output.appendLine("[local-qwen] extension activated");
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

  const refreshCommand = vscode.commands.registerCommand("localQwen.refreshTools", async () => {
    await registry.refresh();
    const tools = registry.getExecutableTools();
    vscode.window.showInformationMessage(
      `Local Qwen Agent discovered ${tools.length} executable tools.`,
    );
  });

  const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
    "local-ollama",
    modelProvider,
  );

  registerLanguageModelTools(context, output);

  void modelProvider.warmModelInfos();
  const pinCopilotSubagentModels = vscode.workspace
    .getConfiguration("localQwen")
    .get<boolean>("pinCopilotSubagentModels", false);
  if (pinCopilotSubagentModels) {
    void pinCopilotAgentModelsToLocal(output);
  } else {
    output.appendLine(
      "[local-qwen] leaving Copilot subagent model settings unchanged (localQwen.pinCopilotSubagentModels=false).",
    );
  }

  // Ensure the extension's debug log files are excluded from workspace search
  // so Copilot's grep_search doesn't match them (they contain previous conversation
  // history and system prompt text, which creates noise for the model).
  void ensureSearchExcludeForDebugLogs(output);

  output.appendLine(
    "[local-qwen] local Ollama models registered. Use directly in Copilot Chat or with @local-qwen participant.",
  );

  const runSmokeTestCommand = vscode.commands.registerCommand(
    "localQwen.runSmokeTest",
    async () => {
      try {
        output.show(true);
        output.appendLine("[local-qwen] running smoke test...");
        const result = await smokeTests.run();
        output.appendLine(`[local-qwen] smoke-test response: ${result.responsePreview}`);

        vscode.window.showInformationMessage(`Smoke test passed with model '${result.modelUsed}'.`);
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

        output.appendLine(`[local-qwen] discovered local models: ${modelNames.join(", ")}`);
        vscode.window.showInformationMessage(`Local models: ${modelNames.join(", ")}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[local-qwen] list models failed: ${text}`);
        vscode.window.showErrorMessage(`Unable to list local models: ${text}`);
      }
    },
  );

  const verifyProviderCommand = vscode.commands.registerCommand(
    "localQwen.verifyModelProvider",
    async () => {
      try {
        const models = await vscode.lm.selectChatModels({
          vendor: "local-ollama",
        });
        const names = models.map((model) => `${model.name} (${model.id})`);

        output.appendLine(
          `[local-qwen] provider verification: ${models.length} model(s) from vendor local-ollama`,
        );

        if (names.length > 0) {
          output.appendLine(`[local-qwen] provider models: ${names.join(", ")}`);
          vscode.window.showInformationMessage(
            `Provider registered: ${models.length} local-ollama model(s) visible to VS Code LM API.`,
          );
        } else {
          vscode.window.showWarningMessage(
            "No local-ollama models were returned by VS Code LM API. Check Extension Host activation and endpoint/model config.",
          );
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output.appendLine(`[local-qwen] provider verification failed: ${text}`);
        vscode.window.showErrorMessage(`Provider verification failed: ${text}`);
      }
    },
  );

  context.subscriptions.push(
    output,
    participant,
    refreshCommand,
    providerRegistration,
    { dispose: () => modelProvider.dispose() },
    runSmokeTestCommand,
    listLocalModelsCommand,
    verifyProviderCommand,
  );
}

export function deactivate(): void {
  cleanupBackgroundProcesses();
}

/**
 * Adds search.exclude patterns for the extension's debug log files so that
 * Copilot's grep_search (and VS Code's search) won't match them.
 * Debug logs contain system prompt text and past conversations — matching them
 * creates noise that confuses the model (e.g. examples mentioning asset paths
 * appear as "real" code matches).
 */
async function ensureSearchExcludeForDebugLogs(output: vscode.OutputChannel): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration("search");
    const currentExclude = config.get<Record<string, boolean>>("exclude") ?? {};

    const patterns = ["**/local-qwen-ollama-outbound*", "**/.local-qwen/**"];

    const missing = patterns.filter((p) => !(p in currentExclude));
    if (missing.length === 0) return;

    const updated = { ...currentExclude };
    for (const p of missing) {
      updated[p] = true;
    }

    await config.update("exclude", updated, vscode.ConfigurationTarget.Workspace);
    output.appendLine(
      `[local-qwen] added search.exclude patterns for debug logs: ${missing.join(", ")}`,
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    output.appendLine(`[local-qwen] failed to update search.exclude (non-fatal): ${text}`);
  }
}

async function pinCopilotAgentModelsToLocal(output: vscode.OutputChannel): Promise<void> {
  try {
    const localModels = await vscode.lm.selectChatModels({
      vendor: "local-ollama",
    });

    if (localModels.length === 0) {
      output.appendLine("[local-qwen] no local models found to pin Copilot agent model settings.");
      return;
    }

    const picked = localModels[0];
    const modelId = picked.id;
    const configuration = vscode.workspace.getConfiguration();
    const keys = [
      "github.copilot.chat.planAgent.model",
      "github.copilot.chat.implementAgent.model",
      "github.copilot.chat.searchSubagent.model",
    ] as const;

    const alreadyConfigured = keys.every((key) => {
      const current = configuration.get<string>(key, "").trim();
      return current.length > 0;
    });

    if (alreadyConfigured) {
      output.appendLine(
        `[local-qwen] Copilot agent model settings already configured; leaving existing values unchanged for keys: ${keys.join(", ")}.`,
      );
      return;
    }

    for (const key of keys) {
      await configuration.update(key, modelId, vscode.ConfigurationTarget.Global);
    }

    output.appendLine(
      `[local-qwen] pinned Copilot agent model settings to '${modelId}' for keys: ${keys.join(", ")}.`,
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    output.appendLine(`[local-qwen] failed to pin Copilot agent models: ${text}`);
  }
}
