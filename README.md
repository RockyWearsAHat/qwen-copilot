# Local Qwen Agent for VS Code Chat

This extension adds a **local chat participant** (`@local-qwen`) to VS Code Chat and runs an agent loop against a local Ollama-compatible model (for example Qwen).
It also registers a **native language model provider** so local Ollama models can appear in VS Code's built-in model system.

## Why this exists

- Use local models with an agent-style tool loop in VS Code Chat
- Keep the UX in the same chat surface you already use
- Future-proof tool availability by discovering tool names from source files at runtime (including Copilot Chat extension files when installed), not from a hardcoded visible-tool list

## What it does

- Registers chat participant: `localQwen.agent` (`@local-qwen`)
- Registers language model provider vendor: `local-ollama` via `languageModelChatProviders`
- Calls local endpoint: `POST /api/chat`
- Supports function/tool calls in a bounded loop (`localQwen.maxAgentSteps`)
- Discovers tool names by scanning source trees and intersecting with executable handlers (`tool_*` exports)

## Implemented executable tools

The executable handler map is derived from exported functions in `src/tools/handlers.ts` using the `tool_` naming convention:

- `read_file`
- `list_dir`
- `file_search`
- `grep_search`
- `run_in_terminal`
- `get_terminal_output`
- `kill_terminal`

## Configuration

- `localQwen.endpoint` (default `http://localhost:11434`)
- `localQwen.model` (default `qwen2.5:32b`)
- `localQwen.maxAgentSteps` (default `6`)
- `localQwen.temperature` (default `0.2`)
- `localQwen.toolDiscoveryRoots` (extra absolute paths to scan)
- `localQwen.maxToolSourceFiles`
- `localQwen.maxToolSourceBytes`
- `localQwen.allowOutsideWorkspaceFileOps`

## Develop

```bash
npm install
npm run compile
npm test
```

Then press `F5` in VS Code to launch an Extension Development Host.

In Chat, address `@local-qwen` and ask normally. Use `/tools` on the participant to inspect discovered executable tools.

## Test in VS Code

1. Start Ollama and ensure your model exists (for example `qwen2.5:32b`).
2. In this project window, run `F5` to open an **Extension Development Host**.
3. In the Extension Host window, open Command Palette and run:
   - `Local Qwen Agent: List Local Models`
   - `Local Qwen Agent: Run Smoke Test`
4. Open the output panel **Local Qwen Agent** and confirm:
   - model list was fetched from the configured endpoint
   - smoke test returned a short response containing `OK`
5. Open Chat and test participant flow:
   - send `@local-qwen /tools`
   - send `@local-qwen read the current file and summarize it`
6. Validate native model-provider path:
   - in Chat model picker, look for provider/models from vendor `local-ollama` (availability depends on VS Code/Copilot channel + feature flags)

## Troubleshooting: model not visible in Copilot Agent picker

If you still do not see Qwen in **Copilot Agent mode** model dropdown:

1. Run `Local Qwen Agent: Verify Model Provider Registration`.
2. If it reports local-ollama models are visible, the provider is registered correctly.
3. In that case, the remaining issue is picker UI policy/filtering in your VS Code/Copilot channel (some Agent mode pickers only show Copilot-managed vendors).
4. You can still use local models through `@local-qwen` participant and through LM API paths that do not enforce Copilot-only vendor filtering.

## Unsupported local patch mode (dynamic autopatch)

If you want Copilot Chat's Agent model dropdown to include and route `local-ollama` models, this repo now includes an **unsupported local autopatcher** for your installed Copilot Chat extension bundle.

### One-time patch

```bash
npm run copilot:autopatch
```

### Auto re-patch after Copilot updates

```bash
npm run copilot:autopatch:watch
```

This watches your extensions directory for new `github.copilot-chat-*` versions and reapplies the patch automatically.

### What gets patched

- `~/.vscode/extensions/github.copilot-chat-*/dist/extension.js`
- Adds local-ollama models to the model list used by Copilot Chat
- Adds fallback execution/token-count routing through VS Code LM API for `local-ollama`
- Infers vision badge (`imageInput`) from local model name/family patterns like `vl`/`vision`
- Caps tool list sent to local models (first 18 tools, truncated descriptions) to reduce prompt/tool token bloat
- Relevance-ranks tools by current user request text before capping, so local model sees a focused Copilot-like tool subset

### Safety and rollback

- First patch creates backup: `extension.js.local-qwen-autopatch.bak`
- To rollback, restore backup and reload VS Code window.

> Note: This patch mode is intentionally unsupported and may break on future Copilot bundle changes. If patch anchors change, `npm run copilot:autopatch` will report `anchor-missing` and skip safely.

### Optional debug settings

Set these in workspace/user settings if needed:

- `localQwen.endpoint`
- `localQwen.model`
- `localQwen.toolDiscoveryRoots`

## Notes

- This project does **not** patch or modify GitHub Copilot internals.
- It integrates via VS Code Chat + Language Model extension APIs and local model endpoints.
- If Copilot Chat is installed, its extension directory is scanned as an additional discovery root for tool-name extraction.
- Native model-picker behavior depends on VS Code/Copilot channel and feature flags. This extension uses the official provider API (`vscode.lm.registerLanguageModelChatProvider`), which is the supported path for built-in model UI integration.
