import * as handlerModule from "./handlers";
import * as vscode from "vscode";
import { reflectToolHandlers } from "./handlerReflection";
import { ToolSourceParser } from "./toolSourceParser";

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

export class ToolRegistry {
  private readonly parser: ToolSourceParser;
  private readonly handlerMap: Map<string, ToolExecutor>;
  private executableTools: ToolDescriptor[] = [];

  public constructor(private readonly output: vscode.OutputChannel) {
    this.parser = new ToolSourceParser(output);
    this.handlerMap = this.buildHandlerMap();
  }

  public async refresh(): Promise<void> {
    const discovered = await this.parser.discoverToolNames();
    const names = [...discovered]
      .filter((name) => this.handlerMap.has(name))
      .sort();

    this.executableTools = names.map((name) => ({
      name,
      description: `Executes local tool: ${name}`,
      parameters: {
        type: "object",
        additionalProperties: true,
      },
    }));

    this.output.appendLine(
      `[local-qwen] Executable tools: ${names.join(", ") || "(none)"}`,
    );
  }

  public getExecutableTools(): ToolDescriptor[] {
    return this.executableTools;
  }

  public getRegisteredHandlerNames(): string[] {
    return [...this.handlerMap.keys()].sort();
  }

  public async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const handler = this.handlerMap.get(name);
    if (!handler) {
      throw new Error(`No executable handler registered for tool '${name}'.`);
    }
    return handler(args);
  }

  private buildHandlerMap(): Map<string, ToolExecutor> {
    return reflectToolHandlers(handlerModule) as Map<string, ToolExecutor>;
  }
}
