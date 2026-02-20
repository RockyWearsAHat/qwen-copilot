# Local Qwen Agent for VS Code Chat

Run local Ollama models directly in VS Code Chat using either **native Copilot Chat** or the **dedicated `@local-qwen` agent**.

## Features

- **Native Copilot Chat**: Select local Ollama models from the model picker
- **Dedicated Agent**: Use `@local-qwen` for reliable agent-mode with tool calling
- **Tool Discovery**: Automatically discovers tools from source files
- **No Remote API Calls**: All inference runs locally on your machine

## Quick Start

1. **Start Ollama** with your model:

   ```bash
   ollama run qwen2.5:32b
   ```

2. **Install this extension** in VS Code

3. **Use in Copilot Chat:**
   - **Option A (Native)**: Open Copilot Chat, select a local model from the model picker dropdown, and chat normally
   - **Option B (Agent)**: Type `@local-qwen ` and select the participant for agent-mode tool calling

## FieldUsage

### Native Copilot Chat (Recommended)

1. Open Copilot Chat
2. Click the model selector (top of chat panel)
3. Choose your Ollama model from the `Local Ollama` section
4. Chat normally

### @local-qwen Agent (Tool Calling)

1. In Copilot Chat, type `@local-qwen ` (with space)
2. Select `@local-qwen` from the dropdown
3. Ask questions that may need tool calls: `read src/main.ts and summarize it`

## Executable Tools

Available for tool calling via both paths:

- `read_file` - Read file contents
- `list_dir` - List directory contents
- `file_search` - Search for files
- `grep_search` - Search file contents
- `run_in_terminal` - Execute shell commands
- `get_terminal_output` - Get command output
- `kill_terminal` - Stop a terminal session

## Configuration

- `localQwen.endpoint` (default `http://localhost:11434`)
- `localQwen.model` (default `qwen2.5:32b`)
- `localQwen.maxAgentSteps` (default `6`)
- `localQwen.temperature` (default `0.2`)
- `localQwen.requestTimeoutMs` (default `120000`)
- `localQwen.modelListTimeoutMs` (default `7000`)
- `localQwen.modelListCacheTtlMs` (default `10000`)
- `localQwen.maxConcurrentRequests` (default `1`)
- `localQwen.maxOutputTokens` (default `0`, model decides)
- `localQwen.contextWindowTokens` (default `0`, model context default)
- `localQwen.maxRequestMessages` (default `0`, full context passthrough)
- `localQwen.maxRequestChars` (default `0`, no char budgeting)
- `localQwen.maxToolsPerRequest` (default `0`, pass all tools)
- `localQwen.toolSchemaMode` (default `compact`)
- `localQwen.toolCallBridgeMode` (default `native-then-delimited`)
- `localQwen.logRequestStats` (default `true`)
- `localQwen.toolDiscoveryRoots` (extra paths to scan for tools)

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` to launch the Extension Development Host.

### Testing

1. Start Ollama: `ollama run qwen2.5:32b`
2. In the Extension Host, open Copilot Chat
3. **Native path**: Select your Ollama model from the model picker
4. **Agent path**: Type `@local-qwen ` and select the participant

Commands available:

- `Local Qwen Agent: List Local Models`
- `Local Qwen Agent: Run Smoke Test`
- `Local Qwen Agent: Refresh Tools`
- `Local Qwen Agent: Verify Model Provider Registration`

### Optional debug settings

Set these in workspace/user settings if needed:

- `localQwen.endpoint`
- `localQwen.model`
- `localQwen.requestTimeoutMs`
- `localQwen.modelListTimeoutMs`
- `localQwen.modelListCacheTtlMs`
- `localQwen.maxConcurrentRequests`
- `localQwen.maxOutputTokens`
- `localQwen.contextWindowTokens`
- `localQwen.maxRequestMessages`
- `localQwen.maxRequestChars`
- `localQwen.maxToolsPerRequest`
- `localQwen.toolSchemaMode`
- `localQwen.toolCallBridgeMode`
- `localQwen.logRequestStats`
- `localQwen.toolDiscoveryRoots`

For unstable local inference (stalls, runaway GPU, delayed cancel), optionally enable tighter limits:

- keep `localQwen.maxConcurrentRequests` at `1`
- lower `localQwen.requestTimeoutMs` to `45000`-`90000`
- keep `localQwen.modelListTimeoutMs` around `3000`-`7000`
- keep `localQwen.modelListCacheTtlMs` at `10000` or higher to avoid repeated probing
- set `localQwen.maxOutputTokens` to `128`-`256` for quick checks
- set `localQwen.contextWindowTokens` to `20000`-`24576` to align with a ~18k token prompt budget
- set `localQwen.maxRequestMessages` to `6`-`10`
- set `localQwen.maxRequestChars` to `8000`-`15000`
- set `localQwen.maxToolsPerRequest` to `4`-`8`

Tool-call bridge modes:

- `native-then-delimited`: use native Ollama tool calling first, then retry with delimiter wrapper when model rejects native tools.
- `native`: strict native tool calling only.
- `delimited`: always use delimiter wrapper tool calls (`<local_qwen_tool_call>{...}</local_qwen_tool_call>`), useful for models without native tool calling support.

Tool schema modes:

- `compact` (default): keeps all tool names but sends minimal schema payload (best for local latency).
- `full`: sends full tool descriptions + JSON schemas.
- `names-only`: sends tool names only with generic object input.

`ollama ps` note:

- `CONTEXT` is the configured context window capacity (`num_ctx`), not the exact token count consumed by the current prompt.
- To see approximate prompt size sent by this extension, open the `Local Qwen Agent` output channel and check `request stats` logs.

## Notes

- This project does **not** patch or modify GitHub Copilot internals.
- It integrates via VS Code Chat + Language Model extension APIs and local model endpoints.
- If Copilot Chat is installed, its extension directory is scanned as an additional discovery root for tool-name extraction.
- Native model-picker behavior depends on VS Code/Copilot channel and feature flags. This extension uses the official provider API (`vscode.lm.registerLanguageModelChatProvider`), which is the supported path for built-in model UI integration.
- In logs, requests labeled `copilotmd` for things like `[title]` and `[progressMessages]` can still run on Copilot-managed cloud models (for UI metadata). The primary chat/agent turn should show your local model (for example `qwen2.5-coder:14b` in `[panel/editAgent-external]`).
