import * as vscode from "vscode";
import {
  ChatRequest,
  LlmMessage,
  LlmToolSpec,
  OllamaClient,
  ToolCall,
} from "../llm/ollamaClient";
import { ToolRegistry } from "../tools/toolRegistry";

export class LocalAgentRunner {
  private readonly llmClient = new OllamaClient();

  public constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async handleRequest(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const endpoint = configuration.get<string>(
      "endpoint",
      "http://localhost:11434",
    );
    const model = configuration.get<string>("model", "qwen2.5:32b");
    const maxAgentSteps = configuration.get<number>("maxAgentSteps", 6);
    const temperature = configuration.get<number>("temperature", 0.2);
    const abortController = new AbortController();

    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      token.onCancellationRequested(() => abortController.abort());
    }

    if (request.command === "tools") {
      await this.toolRegistry.refresh();
      const discovered = this.toolRegistry.getExecutableTools();
      stream.markdown(this.renderTools(discovered.map((tool) => tool.name)));
      return;
    }

    await this.toolRegistry.refresh();
    const tools = this.toLlmTools(this.toolRegistry.getExecutableTools());
    let toolsEnabled = tools.length > 0;

    const messages: LlmMessage[] = [
      {
        role: "system",
        content: [
          "You are a local coding agent inside VS Code Chat.",
          "Prefer calling tools when file or terminal access is needed.",
          "When done, return a concise markdown answer.",
        ].join(" "),
      },
      {
        role: "user",
        content: request.prompt,
      },
    ];

    let finalAnswer = "";

    for (let step = 0; step < maxAgentSteps; step += 1) {
      const chatRequest: ChatRequest = {
        endpoint,
        model,
        tools: toolsEnabled ? tools : [],
        messages,
        temperature,
      };

      let result;
      try {
        result = await this.llmClient.chat(chatRequest, abortController.signal);
      } catch (error) {
        if (
          !toolsEnabled ||
          !(error instanceof Error) ||
          !/does not support tools/i.test(error.message)
        ) {
          throw error;
        }

        toolsEnabled = false;
        this.output.appendLine(
          `[local-qwen] model '${model}' does not support tools; continuing without tool calls.`,
        );
        stream.progress(
          "Selected model does not support tools; retrying without tool calls.",
        );

        result = await this.llmClient.chat(
          {
            ...chatRequest,
            tools: [],
          },
          abortController.signal,
        );
      }
      const assistantMessage = result.message;
      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finalAnswer = assistantMessage.content ?? "";
        break;
      }

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = this.parseToolArgs(toolCall);

        stream.progress(`Running tool ${toolName}...`);
        this.output.appendLine(
          `[local-qwen] tool call: ${toolName}(${JSON.stringify(toolArgs)})`,
        );

        try {
          const toolResult = await this.toolRegistry.execute(
            toolName,
            toolArgs,
          );
          messages.push({
            role: "tool",
            tool_name: toolName,
            content: JSON.stringify(toolResult),
          });
        } catch (error) {
          const errorText =
            error instanceof Error ? error.message : String(error);
          messages.push({
            role: "tool",
            tool_name: toolName,
            content: JSON.stringify({ error: errorText }),
          });
        }
      }
    }

    if (!finalAnswer) {
      finalAnswer =
        "Agent stopped before producing a final answer. Try increasing `localQwen.maxAgentSteps`.";
    }

    stream.markdown(`[LOCAL QWEN] ${finalAnswer}`);
  }

  private parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
    const raw = toolCall.function.arguments;

    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return parsed;
      } catch {
        return {};
      }
    }

    return raw ?? {};
  }

  private toLlmTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>,
  ): LlmToolSpec[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private renderTools(toolNames: string[]): string {
    if (toolNames.length === 0) {
      return "No executable tools discovered yet. Configure `localQwen.toolDiscoveryRoots` and run refresh.";
    }

    return `Discovered tools:\n\n${toolNames.map((name) => `- ${name}`).join("\n")}`;
  }
}
