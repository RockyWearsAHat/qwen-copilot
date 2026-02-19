import * as vscode from 'vscode';
import { OllamaClient } from '../llm/ollamaClient';

export interface SmokeTestResult {
  endpoint: string;
  modelUsed: string;
  availableModels: string[];
  responsePreview: string;
}

export class SmokeTestRunner {
  private readonly client = new OllamaClient();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async listModels(token?: vscode.CancellationToken): Promise<string[]> {
    const configuration = vscode.workspace.getConfiguration('localQwen');
    const endpoint = configuration.get<string>('endpoint', 'http://localhost:11434');
    const abortController = this.createAbortController(token);

    const models = await this.client.listModels(endpoint, abortController.signal);
    return models.map((model) => model.name);
  }

  public async run(token?: vscode.CancellationToken): Promise<SmokeTestResult> {
    const configuration = vscode.workspace.getConfiguration('localQwen');
    const endpoint = configuration.get<string>('endpoint', 'http://localhost:11434');
    const configuredModel = configuration.get<string>('model', 'qwen2.5:32b');
    const temperature = configuration.get<number>('temperature', 0.2);
    const abortController = this.createAbortController(token);

    const models = await this.client.listModels(endpoint, abortController.signal);
    const availableModels = models.map((model) => model.name);
    const modelUsed = this.selectModel(configuredModel, availableModels);

    this.output.appendLine(`[local-qwen] smoke-test endpoint=${endpoint}`);
    this.output.appendLine(`[local-qwen] smoke-test models=${availableModels.join(', ') || '(none)'}`);
    this.output.appendLine(`[local-qwen] smoke-test using model=${modelUsed}`);

    const result = await this.client.chat(
      {
        endpoint,
        model: modelUsed,
        temperature,
        tools: [],
        messages: [
          {
            role: 'user',
            content: 'Smoke test: respond with one short line that includes the word OK.'
          }
        ]
      },
      abortController.signal
    );

    const responsePreview = (result.message.content ?? '').trim();

    return {
      endpoint,
      modelUsed,
      availableModels,
      responsePreview
    };
  }

  private selectModel(configuredModel: string, availableModels: string[]): string {
    if (availableModels.includes(configuredModel)) {
      return configuredModel;
    }

    if (availableModels.length > 0) {
      return availableModels[0];
    }

    return configuredModel;
  }

  private createAbortController(token?: vscode.CancellationToken): AbortController {
    const abortController = new AbortController();

    if (!token) {
      return abortController;
    }

    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      token.onCancellationRequested(() => abortController.abort());
    }

    return abortController;
  }
}
