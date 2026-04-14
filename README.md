# Local Copilot Agents

Transparent **Ollama ↔ VS Code Copilot** bridge — run local LLMs as first-class Copilot language models with optional machine-interaction tools (screenshot, OCR, GUI automation).

## What it does

This extension registers local Ollama models as VS Code `LanguageModelChatProvider`s. Once activated, your Ollama models appear in the Copilot Chat model picker alongside GPT-4o, Claude, etc. Copilot handles all orchestration (tool dispatch, context management, multi-turn reasoning) — this extension is just the translation layer.

**Thin passthrough architecture:**

1. Copilot sends messages + tool specs → extension converts to Ollama format
2. Extension streams Ollama response → converts tool calls back to Copilot format
3. No blocking, no gating, no intent detection, no behavior shaping

## Quick Start

```bash
# 1. Start Ollama with any model
ollama run qwen3-coder:30b

# 2. Install the extension in VS Code (from VSIX or source)
# 3. Open Copilot Chat → model picker → select your local model
# 4. Chat normally — tools, agent mode, everything works
```

## Features

| Feature                       | Description                                                             |
| ----------------------------- | ----------------------------------------------------------------------- |
| **Model auto-discovery**      | Polls Ollama `/api/tags` and registers all available models             |
| **Full tool support**         | Converts all Copilot tools to Ollama format, dispatches tool calls back |
| **Vision support**            | Routes images to vision-capable models (or a dedicated vision sidecar)  |
| **Workspace snapshot**        | Injects file tree + open editors so the model has project context       |
| **Preamble sanitization**     | Compacts Copilot's verbose preamble to save local model context window  |
| **Dynamic context sizing**    | Adjusts `num_ctx` based on actual prompt size and model limits          |
| **Machine interaction tools** | Screenshot, OCR, GUI click/type/scroll, window management (opt-in)      |
| **`@local-qwen` agent**       | Dedicated chat participant with autonomous multi-step loop              |

## Machine Interaction Tools (opt-in)

Enable in settings: `localQwen.enableMachineInteractionTools: true`

| Tool                 | Description                                  |
| -------------------- | -------------------------------------------- |
| `take_screenshot`    | Capture screen or window region              |
| `analyze_image`      | Vision model analysis of screenshots         |
| `ocr_find_text`      | OCR with bounding box coordinates            |
| `gui_click`          | Click at screen coordinates                  |
| `gui_type`           | Type text as keyboard input                  |
| `gui_key`            | Press key combinations                       |
| `gui_scroll`         | Mouse wheel scrolling                        |
| `gui_key_hold`       | Hold a key for a duration                    |
| `list_windows`       | List visible windows                         |
| `focus_window`       | Bring window to foreground                   |
| `launch_app`         | Launch apps or URLs                          |
| `wait_for_condition` | Poll for file/port/process/screen conditions |

## Configuration

All settings live under the `localQwen.*` namespace in VS Code settings.

| Setting                         | Default                  | Description                                         |
| ------------------------------- | ------------------------ | --------------------------------------------------- |
| `endpoint`                      | `http://localhost:11434` | Ollama server URL                                   |
| `model`                         | `qwen2.5:32b`            | Default model for the `@local-qwen` agent           |
| `visionModel`                   | `""`                     | Optional dedicated vision model                     |
| `temperature`                   | `0.2`                    | Sampling temperature                                |
| `promptMode`                    | `guided`                 | System prompt style: `guided` / `minimal` / `none`  |
| `toolsPolicy`                   | `enabled`                | `enabled` / `disabled` (advice-only, no tool calls) |
| `enableWorkspaceSnapshot`       | `true`                   | Inject file tree into prompts                       |
| `sanitizeCopilotPreamble`       | `true`                   | Compact Copilot's verbose preamble                  |
| `performanceProfile`            | `balanced`               | `quality` / `balanced` / `fast`                     |
| `enableMachineInteractionTools` | `false`                  | Enable screenshot/OCR/GUI tools                     |
| `pinCopilotSubagentModels`      | `false`                  | Auto-pin Copilot subagent models to local           |

## Architecture

```
Copilot Chat (orchestrator)
    |
    +-- messages + tool specs
    v
LocalLanguageModelProvider (~800 lines)
    |
    +-- convert messages (MessageConverter)
    +-- convert tool specs (ToolSpecBuilder)
    +-- inject system prompt + workspace snapshot
    +-- handle vision (ollamaVision)
    +-- compute dynamic context window
    |
    v
OllamaClient -> HTTP POST /api/chat (streaming)
    |
    +-- stream text deltas -> LanguageModelTextPart
    +-- stream tool calls -> LanguageModelToolCallPart
    |
    v
Copilot Chat (dispatches tool calls, manages context)
```

**Key principle:** Copilot is the orchestrator. This extension does not:

- Block or filter tool calls
- Detect intent or shape behavior
- Manage multi-turn state beyond what Ollama needs
- Override Copilot's tool selection or context management

## Development

```bash
npm install
npm run compile     # TypeScript -> dist/
npm run test:unit   # Unit tests
npm run watch       # Compile in watch mode
```

Press F5 in VS Code to launch the Extension Development Host.

## Project Structure

```
src/
  extension.ts                     # Activation, registration
  llm/
    localLanguageModelProvider.ts   # Main LM provider (~800 lines)
    ollamaClient.ts                # HTTP client for Ollama API
    ollamaVision.ts                # Vision message preparation
    provider/
      streaming/                   # Response streaming
      message/                     # Message format conversion
      model/                       # Model registry and discovery
      tools/                       # Tool spec conversion
      prompt/                      # System prompt construction
      context/                     # Workspace snapshot
      debug/                       # Debug logging
      utils/                       # Shared utilities
  agent/                           # @local-qwen chat participant
  lmTools/                         # Machine interaction tool registration
  tools/                           # Tool handlers and registry
```

## License

MIT
