import assert from "node:assert/strict";
import * as vscode from "vscode";
import { LocalAgentRunner } from "../../src/agent/localAgent";

type FakeToken = {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
};

function isPlanningRequest(request: any): boolean {
  const system = request?.messages?.[0]?.content;
  return (
    typeof system === "string" &&
    system.includes("You are a planning assistant") &&
    system.includes("output ONLY a valid JSON array")
  );
}

function planningOk() {
  return {
    message: {
      role: "assistant",
      content: "[]",
      tool_calls: [],
    },
  };
}

function createToken(isCancelled = false): FakeToken {
  return {
    isCancellationRequested: isCancelled,
    onCancellationRequested: (listener: () => void) => {
      if (isCancelled) {
        listener();
      }
      return { dispose: () => {} };
    },
  };
}

function withLocalQwenConfig(overrides: Record<string, unknown>): () => void {
  const original = vscode.workspace.getConfiguration;
  Object.defineProperty(vscode.workspace, "getConfiguration", {
    configurable: true,
    value: (_section?: string) => ({
      get: (key: string, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback,
    }),
  });

  return () => {
    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: original,
    });
  };
}

suite("LocalAgentRunner black-box", () => {
  test("tools command lists discovered executable tools", async () => {
    const restoreConfig = withLocalQwenConfig({});
    const streamMarkdown: string[] = [];

    const registry = {
      refreshCalls: 0,
      async refresh() {
        this.refreshCalls += 1;
      },
      getExecutableTools() {
        return [
          { name: "read_file", description: "", parameters: {} },
          { name: "list_dir", description: "", parameters: {} },
        ];
      },
      async execute() {
        throw new Error("execute should not be called in tools mode");
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;
    runner.llmClient = {
      chat: async () => {
        throw new Error("chat should not be called in tools mode");
      },
    };

    const stream = {
      markdown: (value: string) => streamMarkdown.push(value),
      progress: () => {},
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest(
        { command: "tools", prompt: "show tools" } as any,
        stream,
        createToken() as any,
      );

      assert.equal(registry.refreshCalls, 1);
      assert.equal(streamMarkdown.length, 1);
      assert.match(streamMarkdown[0], /Discovered tools:/);
      assert.match(streamMarkdown[0], /read_file/);
      assert.match(streamMarkdown[0], /list_dir/);
    } finally {
      restoreConfig();
    }
  });

  test("returns assistant final answer when model responds without tool calls", async () => {
    const restoreConfig = withLocalQwenConfig({
      endpoint: "http://localhost:11434",
      model: "qwen2.5:32b",
      maxAgentSteps: 4,
      temperature: 0.2,
    });

    const markdown: string[] = [];
    const progress: string[] = [];

    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute() {
        return { ok: true };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    const calls: any[] = [];
    runner.llmClient = {
      chat: async (request: any) => {
        calls.push(request);
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        return {
          message: {
            role: "assistant",
            content: "Done successfully.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: (value: string) => progress.push(value),
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest(
        { prompt: "implement change" } as any,
        stream,
        createToken() as any,
      );

      const executionCalls = calls.filter((call) => !isPlanningRequest(call));
      assert.equal(executionCalls.length, 1);
      assert.equal(executionCalls[0].tools.length, 1);
      assert.deepEqual(markdown, ["[LOCAL QWEN] Done successfully."]);
    } finally {
      restoreConfig();
    }
  });

  test("falls back to tool-less mode when model rejects tools", async () => {
    const restoreConfig = withLocalQwenConfig({
      model: "model-without-tools",
      maxAgentSteps: 3,
    });

    const progress: string[] = [];
    const markdown: string[] = [];
    const outputLines: string[] = [];

    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute() {
        return { ok: true };
      },
    };

    const output = {
      appendLine: (line: string) => outputLines.push(line),
    } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    const requests: any[] = [];
    let first = true;
    runner.llmClient = {
      chat: async (request: any) => {
        requests.push(request);
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        if (first) {
          first = false;
          throw new Error("selected model does not support tools");
        }
        return {
          message: {
            role: "assistant",
            content: "Fallback answer",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: (value: string) => progress.push(value),
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest({ prompt: "read file" } as any, stream, createToken() as any);

      const executionRequests = requests.filter((call) => !isPlanningRequest(call));
      assert.equal(executionRequests.length, 2);
      assert.equal(executionRequests[0].tools.length, 1);
      assert.equal(executionRequests[1].tools.length, 0);
      assert.ok(progress.some((line) => /retrying without tool calls/i.test(line)));
      assert.ok(outputLines.some((line) => /does not support tools/i.test(line)));
      assert.deepEqual(markdown, ["[LOCAL QWEN] Fallback answer"]);
    } finally {
      restoreConfig();
    }
  });

  test("tool-less model can still request tools via tagged JSON fallback", async () => {
    const restoreConfig = withLocalQwenConfig({
      endpoint: "http://localhost:11434",
      model: "model-without-tools",
      maxAgentSteps: 4,
      temperature: 0.2,
    });

    const markdown: string[] = [];
    const progress: string[] = [];
    const outputLines: string[] = [];

    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute(name: string, args: Record<string, unknown>) {
        executed.push({ name, args });
        return { content: "file text" };
      },
    };

    const output = {
      appendLine: (line: string) => outputLines.push(line),
    } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    let call = 0;
    runner.llmClient = {
      chat: async (request: any) => {
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        call += 1;
        if (call === 1) {
          // First call errors because tools were attached.
          throw new Error("selected model does not support tools");
        }
        if (call === 2) {
          // Tool-less retry: request a tool via tagged JSON.
          return {
            message: {
              role: "assistant",
              content:
                '<local_qwen_tool_call>{"tool_calls":[{"name":"read_file","arguments":{"filePath":"/tmp/a","startLine":1,"endLine":5}}]}</local_qwen_tool_call>',
              tool_calls: [],
            },
          };
        }

        return {
          message: {
            role: "assistant",
            content: "Done after reading.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: (value: string) => progress.push(value),
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest(
        { prompt: "read a file then answer" } as any,
        stream,
        createToken() as any,
      );

      assert.equal(executed.length, 1);
      assert.equal(executed[0].name, "read_file");
      assert.deepEqual(executed[0].args, { filePath: "/tmp/a", startLine: 1, endLine: 5 });
      assert.ok(progress.some((line) => /retrying without tool calls/i.test(line)));
      assert.deepEqual(markdown, ["[LOCAL QWEN] Done after reading."]);
      assert.ok(
        outputLines.some((line) => /parsed 1 tool call\(s\) from tagged text fallback/i.test(line)),
      );
    } finally {
      restoreConfig();
    }
  });

  test("propagates cancellation signal to model chat call", async () => {
    const restoreConfig = withLocalQwenConfig({
      endpoint: "http://localhost:11434",
      model: "qwen2.5:32b",
      maxAgentSteps: 2,
      temperature: 0.2,
    });

    let cancelListener: (() => void) | undefined;
    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancelListener = listener;
        return { dispose: () => {} };
      },
    };

    const markdown: string[] = [];
    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute() {
        return { ok: true };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    const observedAbortStates: boolean[] = [];
    runner.llmClient = {
      chat: async (_request: any, signal: AbortSignal) => {
        cancelListener?.();
        observedAbortStates.push(signal.aborted);
        return {
          message: {
            role: "assistant",
            content: "Cancelled request observed.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: () => {},
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest(
        { prompt: "check cancellation" } as any,
        stream,
        cancellationToken as any,
      );

      // Planning call + execution call.
      assert.deepEqual(observedAbortStates, [true, true]);
      assert.deepEqual(markdown, ["[LOCAL QWEN] Cancelled request observed."]);
    } finally {
      restoreConfig();
    }
  });

  test("executes tool calls and feeds tool results back to next model turn", async () => {
    const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 4 });
    const progress: string[] = [];
    const markdown: string[] = [];

    const executeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute(name: string, args: Record<string, unknown>) {
        executeCalls.push({ name, args });
        return { content: "file text" };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    const requests: any[] = [];
    let turn = 0;
    runner.llmClient = {
      chat: async (request: any) => {
        requests.push(request);
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        turn += 1;
        if (turn === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "read_file",
                    arguments: { filePath: "/tmp/a" },
                  },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "Applied changes.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: (value: string) => progress.push(value),
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest(
        { prompt: "read then answer" } as any,
        stream,
        createToken() as any,
      );

      assert.equal(executeCalls.length, 1);
      assert.deepEqual(executeCalls[0], {
        name: "read_file",
        args: { filePath: "/tmp/a" },
      });
      assert.ok(progress.some((line) => /Running tool read_file/i.test(line)));
      const executionRequests = requests.filter((call) => !isPlanningRequest(call));
      assert.equal(executionRequests.length, 2);
      const toolMessage = executionRequests[1].messages.find(
        (message: any) => message.role === "tool" && message.tool_name === "read_file",
      );
      assert.ok(toolMessage);
      assert.equal(toolMessage.content, JSON.stringify({ content: "file text" }));
      assert.deepEqual(markdown, ["[LOCAL QWEN] Applied changes."]);
    } finally {
      restoreConfig();
    }
  });

  test("executes multiple tool calls from one model turn", async () => {
    const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 4 });
    const progress: string[] = [];
    const markdown: string[] = [];

    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [
          { name: "read_file", description: "Read", parameters: {} },
          { name: "grep_search", description: "Search", parameters: {} },
        ];
      },
      async execute(name: string, args: Record<string, unknown>) {
        executed.push({ name, args });
        return { ok: true, name };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    let turn = 0;
    runner.llmClient = {
      chat: async (request: any) => {
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        turn += 1;
        if (turn === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "read_file",
                    arguments: {
                      filePath: "/tmp/a",
                      startLine: 1,
                      endLine: 50,
                    },
                  },
                },
                {
                  function: {
                    name: "grep_search",
                    arguments: { query: "needle", isRegexp: false },
                  },
                },
              ],
            },
          };
        }

        return {
          message: {
            role: "assistant",
            content: "Completed both tools.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: (value: string) => progress.push(value),
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest({ prompt: "run two tools" } as any, stream, createToken() as any);

      assert.equal(executed.length, 2);
      assert.deepEqual(
        executed.map((entry) => entry.name),
        ["read_file", "grep_search"],
      );
      assert.ok(progress.some((line) => /Running tool read_file/i.test(line)));
      assert.ok(progress.some((line) => /Running tool grep_search/i.test(line)));
      assert.deepEqual(markdown, ["[LOCAL QWEN] Completed both tools."]);
    } finally {
      restoreConfig();
    }
  });

  test("handles malformed tool arguments and tool execution failures deterministically", async () => {
    const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 3 });
    const markdown: string[] = [];

    const receivedArgs: Record<string, unknown>[] = [];
    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "write_file", description: "Write", parameters: {} }];
      },
      async execute(_name: string, args: Record<string, unknown>) {
        receivedArgs.push(args);
        throw new Error("write failed");
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    const requests: any[] = [];
    let turn = 0;
    runner.llmClient = {
      chat: async (request: any) => {
        requests.push(request);
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        turn += 1;
        if (turn === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "write_file",
                    arguments: "{malformed-json",
                  },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "Recovered with explanation.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: () => {},
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest({ prompt: "write file" } as any, stream, createToken() as any);

      assert.deepEqual(receivedArgs, [{}]);
      const executionRequests = requests.filter((call) => !isPlanningRequest(call));
      assert.equal(executionRequests.length, 2);
      const toolMessage = executionRequests[1].messages.find(
        (message: any) => message.role === "tool" && message.tool_name === "write_file",
      );
      assert.ok(toolMessage);
      assert.equal(toolMessage.content, JSON.stringify({ error: "write failed" }));
      assert.deepEqual(markdown, ["[LOCAL QWEN] Recovered with explanation."]);
    } finally {
      restoreConfig();
    }
  });

  test("returns deterministic fallback when max agent steps end before final answer", async () => {
    const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 1 });
    const markdown: string[] = [];

    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute() {
        return { ok: true };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    runner.llmClient = {
      chat: async (request: any) => {
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "read_file",
                  arguments: { filePath: "/tmp/a" },
                },
              },
            ],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: () => {},
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest({ prompt: "do work" } as any, stream, createToken() as any);

      assert.equal(markdown.length, 1);
      assert.match(markdown[0], /Agent stopped before producing a final answer/);
    } finally {
      restoreConfig();
    }
  });

  test("stops tool-only loop at configured max steps", async () => {
    const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 2 });
    const markdown: string[] = [];

    let executeCalls = 0;
    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [{ name: "read_file", description: "Read", parameters: {} }];
      },
      async execute() {
        executeCalls += 1;
        return { ok: true };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    let chatCalls = 0;
    runner.llmClient = {
      chat: async (request: any) => {
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        chatCalls += 1;
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "read_file",
                  arguments: { filePath: "/tmp/a", startLine: 1, endLine: 5 },
                },
              },
            ],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: () => {},
    } as unknown as vscode.ChatResponseStream;

    try {
      await runner.handleRequest({ prompt: "keep going" } as any, stream, createToken() as any);

      assert.equal(chatCalls, 2);
      assert.equal(executeCalls, 2);
      assert.equal(markdown.length, 1);
      assert.match(markdown[0], /Agent stopped before producing a final answer/);
    } finally {
      restoreConfig();
    }
  });

  test("executes simple 'start a new vite project' flow quickly in isolated test env", async () => {
    const restoreConfig = withLocalQwenConfig({ maxAgentSteps: 4 });
    const markdown: string[] = [];
    const progress: string[] = [];

    const isolatedEnvPath = "/tmp/local-qwen-speed-flow-env";
    const forbiddenPath = "/Users/alexwaldmann/anthropic-copilot/testEnv";

    const executeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const registry = {
      async refresh() {},
      getExecutableTools() {
        return [
          {
            name: "create_new_workspace",
            description: "Scaffold a new project workspace.",
            parameters: {},
          },
        ];
      },
      async execute(name: string, args: Record<string, unknown>) {
        executeCalls.push({ name, args });
        return { workspacePath: isolatedEnvPath, ok: true };
      },
    };

    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const runner = new LocalAgentRunner(registry as any, output) as any;

    let turn = 0;
    runner.llmClient = {
      chat: async (request: any) => {
        if (isPlanningRequest(request)) {
          return planningOk();
        }
        turn += 1;
        if (turn === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  function: {
                    name: "create_new_workspace",
                    arguments: {
                      query: `start a new vite project in ${isolatedEnvPath}`,
                    },
                  },
                },
              ],
            },
          };
        }

        return {
          message: {
            role: "assistant",
            content: "Created a new Vite project workspace.",
            tool_calls: [],
          },
        };
      },
    };

    const stream = {
      markdown: (value: string) => markdown.push(value),
      progress: (value: string) => progress.push(value),
    } as unknown as vscode.ChatResponseStream;

    const startedAt = Date.now();

    try {
      await runner.handleRequest(
        { prompt: "start a new vite project" } as any,
        stream,
        createToken() as any,
      );

      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 1000, `expected fast flow, got ${elapsedMs}ms`);

      assert.equal(executeCalls.length, 1);
      assert.equal(executeCalls[0].name, "create_new_workspace");
      assert.equal(executeCalls[0].args.query, `start a new vite project in ${isolatedEnvPath}`);
      assert.ok(
        String(executeCalls[0].args.query).includes(isolatedEnvPath),
        "expected isolated temp test env path",
      );
      assert.equal(String(executeCalls[0].args.query).includes(forbiddenPath), false);

      assert.ok(progress.some((line) => /Running tool create_new_workspace/i.test(line)));
      assert.deepEqual(markdown, ["[LOCAL QWEN] Created a new Vite project workspace."]);
    } finally {
      restoreConfig();
    }
  });
});
