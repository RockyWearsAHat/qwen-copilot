# Technical architecture and local Qwen-Coder integration for vscode-copilot-chat

## Executive summary

The `vscode-copilot-chat` codebase is a highly modular VS Code extension built around (a) **dependency-injected services**, (b) **“contributions”** that register features at activation, and (c) a **TSX-based prompt renderer** that enforces token budgets by pruning low-priority prompt parts. The extension is designed to run in both **Node extension hosts** and **web-worker extension hosts**, with explicit “layer” boundaries (`common`, `vscode`, `node`, `vscode-node`, `worker`, `vscode-worker`). citeturn21view0turn22view0turn22view2

At the model-IO boundary, the key abstraction is **`IChatEndpoint`**. “Copilot” vendor models are routed to a `CopilotChatEndpoint` (remote Copilot infrastructure) while non-Copilot vendor models are routed through an `ExtensionContributedChatEndpoint`. The endpoint routing is centralized in `ProductionEndpointProvider`. citeturn24view0turn25view3turn15view0

The “bridge” you are implementing (your adapter) is most stable if it presents your local Qwen-Coder inference as an **OpenAI-compatible Chat Completions API** and is then surfaced to VS Code as a **non-copilot model** (BYOK / provider group). This avoids “intercepting Copilot calls” at the Copilot-proxy level (which would require mimicking internal Copilot endpoints) and instead uses the extension’s designed-by-construction path for local/third-party models. citeturn24view0turn24view2turn25view2turn20search6turn13search4

A crucial architectural detail: the Copilot Chat extension uses a shared wrapper, `CopilotLanguageModelWrapper`, for both Copilot-hosted endpoints and BYOK OpenAI-compatible endpoints. That wrapper is where token budgeting, tool wiring (OpenAI function-tool schema), streaming delta parsing, and error shaping occurs—so your local endpoint must be compatible with what `ChatEndpoint` expects to parse. citeturn14view1turn15view0turn25view0

## Repository architecture and runtime composition

### Layering model and build targets

The repository explicitly frames architecture in terms of “layers” tied to runtime APIs (plain JS vs VS Code APIs vs Node APIs), because the extension supports both Node extension hosts and web worker extension hosts. The documented layers include `common`, `vscode`, `node`, `vscode-node`, `worker`, and `vscode-worker`. citeturn21view0

Two primary runtime entrypoints are called out:

- `src/extension/extension/vscode-node/extension.ts` for Node extension hosts  
- `src/extension/extension/vscode-worker/extension.ts` for web worker extension hosts citeturn21view0turn22view2

The Node entrypoint is minimal: it delegates activation to `baseActivate`, wires `registerServices`, and supplies the `vscodeNodeContributions` list. citeturn22view2turn22view3

### Extension activation and contribution loading

**Node activation entrypoint**  
`src/extension/extension/vscode-node/extension.ts` exports `activate(context, forceActivation?)` which calls `baseActivate({ context, registerServices, contributions: vscodeNodeContributions, configureDevPackages, forceActivation })`. citeturn22view2turn21view0

**Contribution registration**  
`src/extension/extension/vscode-node/contributions.ts` defines two major contribution lists:

- `vscodeNodeContributions`: loaded in the Node extension host, includes `ConversationFeature`, `AuthenticationContrib`, `LanguageModelAccess`, chat sessions, quota, tools, MCP integration, etc. citeturn22view3  
- `vscodeNodeChatContributions`: instantiated only when “logged in and chat is enabled,” including `ToolsContribution`, `BYOKContrib`, RemoteAgent support, prompt files, and others. citeturn22view3

This split is a critical architectural point: if you are adapting behavior specifically for model routing, you generally want to attach to a **service** (`IEndpointProvider`, `IChatMLFetcher`, `IFetcherService`) rather than a “feature contribution,” unless you deliberately want the behavior gated behind “chat enabled + logged in.”

### Service registration and the key routing services

`src/extension/extension/vscode-node/services.ts` is where the DI container is populated.

The highest-leverage services for model routing are:

- `IEndpointProvider` → `ProductionEndpointProvider` (normal) or `ScenarioAutomationEndpointProviderImpl` (automation) citeturn23view1turn24view0turn24view1  
- `IFetcherService` → `FetcherService` (network execution) citeturn23view1turn15view0  
- `IChatMLFetcher` → `ChatMLFetcherImpl` (prompt/request transport, referenced by endpoints) citeturn23view1turn25view0  
- `ITokenizerProvider` → `TokenizerProvider` (token counting) citeturn23view1turn14view1turn15view0  
- telemetry and experimentation services (`TelemetryService`, `MicrosoftExperimentationService`) are configured for production and replaced with null services otherwise. citeturn23view2

The `ProductionEndpointProvider` is the core switching point between:

- **Copilot vendor models** → `CopilotChatEndpoint`  
- **Non-Copilot vendor models** → `ExtensionContributedChatEndpoint` citeturn24view0

This matters for your adapter: “local Qwen-Coder” should appear as a **non-copilot** model if you want the least invasive, forward-compatible integration.

## Request lifecycle and data flow

### Participant-to-model flow in normal chat

The chat UX is implemented via VS Code chat participants.

`src/extension/conversation/vscode-node/chatParticipants.ts` registers multiple participants (default agent, editing agents, terminal agents, notebook agents, etc.). Each participant uses `vscode.chat.createChatParticipant(id, handler)` and wires feedback/action handlers, welcome text, title provider, and summarizer. citeturn11view1turn21view0

When the user submits a prompt:

1. VS Code invokes the participant request handler. citeturn12view2  
2. The extension starts an interaction (`interactionService.startInteraction()`), optionally categorizes the first prompt for telemetry, resolves the “intent” (slash commands + agent mapping), and instantiates a `ChatParticipantRequestHandler(...)`. citeturn12view2turn11view1  
3. The request handler drives “intent” prompt building and then model invocation (details live deeper in intent/prompt modules; the repo explicitly highlights `agentPrompt.tsx`, `agentInstructions.tsx`, and `toolCallingLoop.ts` as entrypoints for agent mode). citeturn21view0

### Model availability and the Language Model Chat Provider API

A distinct but connected path is the Language Model provider registration:

`src/extension/conversation/vscode-node/languageModelAccess.ts` registers a `LanguageModelChatProvider` under vendor id `'copilot'` via `vscode.lm.registerLanguageModelChatProvider('copilot', provider)`. citeturn11view0

This provider exposes three key hooks to VS Code:

- `provideLanguageModelChatInformation` → returns models for the picker  
- `provideLanguageModelChatResponse` → executes a request  
- `provideTokenCount` → token counting for budgeting citeturn11view0turn12view0

Model enumeration pulls from `IEndpointProvider.getAllChatEndpoints()`, adds an `AutoChatEndpoint`, and shapes each model’s max input/output tokens using a cached “base prompt tokens” count. citeturn12view0turn15view2

A subtle but important detail for tool-heavy agent flows: the provider computes `maxInputTokens` shown to VS Code as:

`endpoint.modelMaxPromptTokens - baseCount - BaseTokensPerCompletion` (and later also subtracts tool schema token cost at request time). citeturn12view0turn14view1turn15view0

### Prompt engineering and context window enforcement

The repository’s prompt system is built on a TSX prompt framework. The key design goal is: **build a message tree with priorities, then prune to fit a token budget**. This is described as a motivation for TSX prompts and a central mechanism of `PromptRenderer`. citeturn21view0

At request time, `CopilotLanguageModelWrapper`:

- counts tool schema tokens (if tools are supplied),  
- computes base prompt tokens,  
- constructs a token limit,  
- calls `PromptRenderer.create(...).render()` which returns `{ messages, tokenCount }`, and  
- throws if the rendered prompt exceeds the allowed token budget. citeturn14view1turn12view1

Agent mode adds another layer of context control: there is an explicit configuration path to write large tool results to disk instead of embedding them in the prompt, to avoid exhausting the context window. citeturn10view0

### Endpoint routing and network request formation

Once prompt messages exist, the wrapper does not directly call `fetch`. It calls `endpoint.makeChatRequest(...)`. citeturn14view1turn15view0

The relevant endpoint contract is `IChatEndpoint`, which includes:

- endpoint metadata (tokenizer, model family, max prompt tokens, max output tokens, policy, etc.)  
- `makeChatRequest(...)` returning a typed `ChatResponse`  
- `processResponseFromChatEndpoint(...)` to parse response formats  
- `cloneWithTokenOverride(...)` for budgeting adjustments. citeturn15view0turn20search2

At the lower level, requests are made with a standardized header set (including `Authorization: Bearer ...`, `X-Request-Id`, and intent headers like `X-Interaction-Type` and `OpenAI-Intent`) and a 30s timeout; the network layer can disconnect/retry once for specific transient errors (e.g., `ECONNRESET`, `ETIMEDOUT`, several HTTP/2 errors). citeturn15view0

### Streaming vs non-streaming response handling

The wrapper is explicitly structured around streamed deltas:

- it reports text deltas via `LanguageModelTextPart`,  
- tool call deltas via `LanguageModelToolCallPart`,  
- and a stateful marker via `LanguageModelDataPart(encodeStatefulMarker(...), CustomDataPartMimeTypes.StatefulMarker)`. citeturn14view1turn11view0

Tool call arguments are parsed as JSON (`JSON.parse(call.arguments || '{}')`), and invalid JSON becomes an error. citeturn14view1

For BYOK/OpenAI-compatible endpoints, `OptionalChatRequestParams` includes `stream` and `stream_options.include_usage`, with a note that total usage may appear only in the final chunk and may be missing if interrupted. citeturn15view1

Separately, the endpoint model metadata includes an explicit `supports.streaming` capability flag; if not explicitly true, the system “will try to parse the response as not streamed.” This is relevant when your local server cannot do SSE streaming reliably. citeturn15view2turn15view0

### Mermaid flowchart of request routing

```mermaid
flowchart TD
  U[User prompt in VS Code Chat UI] --> P[vscode.chat participant handler]
  P --> I[Intent resolution & ChatParticipantRequestHandler]
  I --> R[PromptRenderer (TSX) builds & prunes messages]
  R --> W[CopilotLanguageModelWrapper validates tools + token budget]
  W --> EP[ProductionEndpointProvider.getChatEndpoint(...)]

  EP -->|vendor=copilot| CE[CopilotChatEndpoint (remote Copilot)]
  EP -->|vendor!=copilot| XE[ExtensionContributedChatEndpoint (3rd-party / local)]
  
  CE --> MR1[endpoint.makeChatRequest -> network layer]
  XE --> MR2[endpoint.makeChatRequest -> network layer]

  MR1 --> PR1[processResponseFromChatEndpoint]
  MR2 --> PR2[processResponseFromChatEndpoint]
  PR1 --> S[Streaming deltas -> Chat UI]
  PR2 --> S[Streaming deltas -> Chat UI]

  S -->|tool calls| T[vscode.lm.invokeTool / tool execution loop]
  T --> R2[tool result appended to history]
  R2 --> R
```

This diagram reflects the repo’s explicit endpoint-routing design and the wrapper’s streaming/tool-call reporting behavior. citeturn24view0turn15view0turn14view1turn21view0

## Authentication, telemetry, quotas, and error surfaces

### Authentication and entitlement gates

In normal runtime (non-scenario automation), the extension registers:

- `IAuthenticationService` → `AuthenticationService`  
- `ICopilotTokenManager` → `VSCodeCopilotTokenManager` citeturn23view2

Many behaviors are gated on the presence and shape of a Copilot token. For example, `LanguageModelAccess` clears model lists when authentication is removed and relies on `getCopilotToken()` to enable language models/embeddings. citeturn12view0turn11view0

VS Code’s own documentation also notes that using local/BYOK models **still requires Copilot service access and being online for some tasks**, and you **still need a Copilot plan** (at least for the current documented behavior). citeturn20search6turn13search4

### Telemetry emission points

Telemetry is configured in `services.ts`:

- In production, it wires `ITelemetryService` → `TelemetryService` (with multiple AI keys)  
- In development/test, it wires `ITelemetryService` → `NullTelemetryService`. citeturn23view2

Model invocation telemetry:

- `CopilotLanguageModelWrapper` sends an MSFT telemetry event named `languagemodelrequest` with extension id/version, model id, tokenCount, and tokenLimit. citeturn14view1  
- It sends a second internal event including request id and query content. citeturn14view1

GitHub API telemetry + rate limiting:

- `makeGitHubAPIRequest` and `makeGitHubGraphQLRequest` log remaining rate limit via the `x-ratelimit-remaining` header and send telemetry `githubAPI.approachingRateLimit` when remaining drops below 1000. citeturn11view2

BYOK-related telemetry / network calls:

- The BYOK feature fetches a “known model list” JSON from a VS Code CDN URL and updates provider registries. That is a distinct outbound request you should account for in threat modeling and offline expectations. citeturn24view2

### Quotas, fallback models, and error mapping

Quota-driven model switching (premium → base):

- The chat participants layer explicitly switches to a base model when the user exhausts premium request allowance, and warns the user in-stream. It also explicitly does **not** switch when the request is “BYOK” or otherwise free (`endpoint.multiplier === 0` or vendor != `'copilot'`). citeturn12view2

Error typing:

- `CopilotLanguageModelWrapper` maps non-success `ChatFetchResponseType` into typed errors:
  - `ExtensionBlocked` → `LanguageModelError.Blocked`
  - `QuotaExceeded` → error named `ChatQuotaExceeded`
  - `RateLimited` → error named `ChatRateLimited`
  - otherwise throws generic `Error(result.reason)`. citeturn14view1turn15view1

Network error hardening:

- The request layer retries once after `disconnectAll()` on a known set of transient network errors and enforces a 30-second request timeout. citeturn15view0

## Local Qwen-Coder integration design and implementation

### The practical integration choices

There are three architecturally distinct ways to use a local Qwen-Coder model “through Copilot Chat UI”:

**Use Copilot Chat’s BYOK / local model support (recommended)**  
You expose Qwen-Coder behind an OpenAI-compatible endpoint (or run it via a provider like Ollama), then register it as a non-copilot model so `ProductionEndpointProvider` routes to `ExtensionContributedChatEndpoint`. This leverages the existing, supported “non-copilot” path. citeturn24view0turn20search6turn24view2turn25view2

**Implement a new BYOK provider inside this repo (still forward-compatible)**  
You add a new `BYOKModelRegistry` / provider similar to `OllamaLMProvider`, but targeting your own local inference server. This keeps UI integration in “Manage Models” and reuses `CopilotLanguageModelWrapper` end-to-end. citeturn24view2turn24view3turn25view2

**Hard intercept of Copilot vendor calls (high risk / brittle)**  
You modify `ProductionEndpointProvider.getChatEndpoint` so that when a copilot vendor model is selected it returns a local endpoint instead of `CopilotChatEndpoint`. This path is technically feasible (because `getChatEndpoint` is centralized), but it breaks assumptions around Copilot quotas, entitlement policies, and server-side features; it can also put you in a gray zone with respect to product terms if your goal is to bypass Copilot service usage requirements. Architecturally, it is least stable across upstream changes. citeturn24view0turn20search6turn13search4

Given your request for “down-to-the-letter” architecture: the repo strongly suggests that “bring your own model” should be surfaced through the **existing non-copilot endpoint path**—either as an extension-provided model or via the BYOK providers already implemented. citeturn24view0turn24view2turn25view2

### What your local server must look like to “plug in cleanly”

Because `CopilotLanguageModelWrapper` converts VS Code `tools` into OpenAI function-tool schemas and expects streamed deltas, the cleanest contract is:

- `GET /v1/models` returning an OpenAI-style model list (used by `AbstractOpenAICompatibleLMProvider.getModelsFromEndpoint`). citeturn25view2  
- `POST /v1/chat/completions` supporting:
  - streaming SSE **or** non-streaming JSON, consistent with the model metadata capability `supports.streaming` citeturn15view2turn14view1  
  - `tools` and `tool_choice` fields if you want agent/tool calling to work (since the wrapper injects these). citeturn14view1turn15view1  
  - `stream_options.include_usage` best-effort, because the wrapper may request it (BYOK endpoint injects it when streaming). citeturn15view1turn25view0

If your server returns tool calls, they must be parseable into JSON arguments (the wrapper throws on invalid JSON). citeturn14view1

### Qwen-Coder model constraints that affect Copilot Chat behavior

**Context size and token budgeting**  
The Qwen2.5-Coder-7B-Instruct model card states a “full” context length of 131,072 tokens and highlights “long-context support up to 128K tokens,” while also noting that the default `config.json` is set for 32,768 and that longer-context usage relies on YaRN RoPE scaling. citeturn27view0

This matters because Copilot Chat will compute `tokenLimit = endpoint.modelMaxPromptTokens - baseCount - BaseTokensPerCompletion - toolTokenCount`, and it will prune context to fit. If you register the model with too-small `maxInputTokens`, you will see aggressive pruning and degraded agent performance. citeturn14view1turn12view0turn21view0

**Instruction formatting**  
The same model card shows the recommended `apply_chat_template` usage and includes a default system line (“You are Qwen, created by Alibaba Cloud…”). If your serving stack handles chat templates internally (common in OpenAI-compatible servers), you should ensure it uses a Qwen-compatible template; otherwise, you must implement formatting before generation. citeturn27view0turn26search13

### Model serving options for local Qwen-Coder

The table below focuses on *how well each serving option matches what Copilot Chat expects* (OpenAI compatibility, streaming, tool calls), and what you would need to install.

| Serving approach | OpenAI-compatible `/v1/chat/completions` | Streaming SSE | Tool calling pathway | Typical setup complexity | Notes & supporting sources |
|---|---:|---:|---|---|---|
| **vLLM OpenAI-compatible server** | Yes citeturn26search2turn27view1 | Yes (designed for it) citeturn26search2turn27view1 | Possible with tool parsing flags (framework feature) citeturn27view1 | Medium | Qwen docs explicitly recommend vLLM and show a local OpenAI-compatible server example. citeturn27view1 |
| **Ollama** (with Copilot Chat’s Ollama provider) | Copilot Chat targets `…/v1/chat/completions` for Ollama citeturn24view3 | Depends on Ollama OpenAI-compat layer; Copilot path assumes it citeturn24view3 | Tool calling advertised via Ollama model capabilities (“tools”) and surfaced in provider metadata citeturn24view3turn20search6 | Low | Copilot Chat has a first-party BYOK provider for Ollama and a default base URL of `http://localhost:11434`. citeturn24view3turn20search6 |
| **llama.cpp llama-server** (GGUF) | Often OpenAI-compatible server mode is used by downstream tools; project aims at local inference citeturn26search3 | Yes in server mode (implementation-dependent) | Tool calling support varies; Qwen docs provide llama.cpp guidance (model-family dependent) citeturn26search15turn26search3 | Medium | Good for CPU/GPU quantized inference (GGUF). Qwen docs include llama.cpp “run locally” guides. citeturn26search15turn26search3 |
| **PyTorch Transformers + custom FastAPI** | Only if you implement it | Up to you | Up to you (hard) | High | Best if you want full control (templates, constrained decoding), but you must implement OpenAI compatibility and streaming yourself. Qwen docs show Transformers chat usage patterns. citeturn26search13turn27view0 |
| **ONNX / ORT** | Only if you implement a serving layer | Up to you | Up to you | High | Useful for CPU deployments; the integration burden with Copilot Chat remains the OpenAI-compatible surface. (Choose this only if you already maintain an ONNX serving stack.) |

Resource needs (estimation approach): Qwen2.5-Coder sizes span up to 32B parameters in the family. citeturn27view0  
For rough VRAM/RAM planning, you can estimate *weights-only* memory as `params × bytes_per_weight` (e.g., BF16/FP16 ≈ 2 bytes). For the 7B instruct model (7.61B parameters), weights-only FP16 is ~15.2GB before KV cache and runtime overhead, which is why quantization or GPU offload strategies are common for consumer hardware. citeturn27view0  
If you choose Ollama, its own guidance states minimum RAM guidance for “7B” class models (as a rule of thumb). citeturn8search4

### Concrete implementation path A: no fork—use BYOK + OpenAI-compatible server

This is the shortest path to “Copilot Chat UI + local Qwen-Coder responses,” and it aligns with the extension’s endpoint routing design.

#### Serve Qwen-Coder behind an OpenAI-compatible endpoint

**vLLM (recommended by Qwen docs)**  
Qwen docs show `vllm serve …` and a local OpenAI-compatible endpoint on port 8000. Replace the model name with the Qwen-Coder variant you are using. citeturn27view1turn27view0

Example (run locally):

```bash
pip install "vllm>=0.8.5"
vllm serve Qwen/Qwen2.5-Coder-7B-Instruct --host 127.0.0.1 --port 8000
```

The Qwen docs include the expected OpenAI-style request shape for `/v1/chat/completions`. citeturn27view1

#### Register the model in VS Code / Copilot Chat

VS Code’s “Language Models” and BYOK docs describe how to add models via built-in providers (including locally hosted ones via providers like Ollama) and note that tool calling capability is required for agent-mode visibility. citeturn20search6turn13search4

Your integration choices depend on what your VS Code channel supports:

- If you can configure a custom OpenAI-compatible model via settings, VS Code docs mention `github.copilot.chat.customOAIModels` as the manual configuration path (notably discussed for Insiders at certain points). citeturn20search6turn5view3
- If you use Ollama, Copilot Chat’s Ollama provider defaults to `http://localhost:11434` and explicitly references the setting `github.copilot.chat.byok.ollamaEndpoint` for pointing to a non-default host. citeturn24view3

### Concrete implementation path B: add a “Local OpenAI-compatible provider” inside this repo

If you need deeper control (or you want your “adapter” to be bundled with this extension), the “BYOK provider” architecture is the most direct and stable way to do it.

#### Where to hook into BYOK

The BYOK feature is implemented as a contribution:

- `BYOKContrib` registers multiple `BYOKModelRegistry` instances (Anthropic, Azure, Gemini, Groq, OpenAI, Ollama, OpenRouter, etc.) and wires the `github.copilot.chat.manageModels` command. citeturn24view2
- Each provider ultimately exposes models via the Language Model Chat provider API and routes requests through `CopilotLanguageModelWrapper` by constructing an `OpenAIEndpoint`. citeturn25view2turn25view0turn14view1

So: your “local Qwen server” provider can be implemented as “OpenAI-compatible, possibly no auth,” similar to `OllamaLMProvider` but with different discovery/configuration.

#### Minimal new provider outline

Create a new file:

- `src/extension/byok/vscode-node/localOpenAICompatibleProvider.ts`

Implement as a subclass of `AbstractOpenAICompatibleLMProvider`, reusing the existing `OpenAIEndpoint` machinery. citeturn25view2turn25view0

Key decisions:

- How you get a base URL (setting, UI group config, env var).
- Whether you require an API key. If not, you still might pass a placeholder; your local server can ignore it.

Sketch:

```ts
import { AbstractOpenAICompatibleLMProvider, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';

export interface LocalServerConfig {
  url: string;
  apiKey?: string;
}

export class LocalQwenProvider extends AbstractOpenAICompatibleLMProvider<LocalServerConfig> {
  public static readonly providerName = 'Local OpenAI-Compatible';

  protected getModelsBaseUrl(configuration: LocalServerConfig | undefined): string | undefined {
    return configuration?.url ?? 'http://127.0.0.1:8000/v1';
  }

  // Optionally override getModelsDiscoveryUrl if your server uses a different path.
  protected override getModelsDiscoveryUrl(modelsBaseUrl: string): string {
    return `${modelsBaseUrl}/models`;
  }

  // If you want to hardcode capabilities when /models doesn’t provide enough metadata,
  // override resolveModelCapabilities(...) and/or getModelInfo(...).
}
```

This follows the same contract used by the existing OpenAI-compatible BYOK providers. citeturn25view2turn24view3

#### Wire it into Manage Models

In `src/extension/byok/vscode-node/byokContribution.ts`, add it to `_modelRegistries` alongside the other providers, and decide an auth type (none vs global key). citeturn24view2

This is the “down-to-the-letter” integration point that ensures your provider is discoverable through `github.copilot.chat.manageModels`.

### Concrete implementation path C: “adapter proxy” that reshapes requests for Qwen

If you are “in the midst of coding” an adapter, the clean target is:

- Accept **OpenAI Chat Completions** requests from Copilot Chat
- Translate them to your backend (Transformers, llama.cpp, whatever)
- Return OpenAI-style responses (streamed deltas if possible)

This works because Copilot Chat’s OpenAI-compatible path is implemented via `OpenAIEndpoint` (BYOK) and relies on the OpenAI schema (tools, tool_choice, streaming deltas). citeturn25view0turn15view1turn14view1

#### Files and behaviors you must match

From the extension side:

- The wrapper converts tools to OpenAI function tool schemas. citeturn14view1turn15view1  
- Tool calls must have JSON-parsable arguments. citeturn14view1  
- For BYOK streaming, `OpenAIEndpoint.interceptBody` injects `stream_options: { include_usage: true }` when `stream` is set. citeturn25view0turn15view1

Therefore, your adapter should accept and tolerate:

- requests with `tools`, `tool_choice`, and `stream_options.include_usage`
- large message arrays that include system/user/assistant turns (potentially with tool results)

#### Example Node.js/TypeScript “compatibility proxy” skeleton

This pattern is useful when your backend cannot speak OpenAI Chat Completions directly.

```ts
import http from 'node:http';
import { URL } from 'node:url';

// Minimal types: you should expand these to match your needs.
type ChatCompletionRequest = {
  model: string;
  messages: Array<{ role: string; content: any }>;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  temperature?: number;
};

function writeSse(res: http.ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'Qwen2.5-Coder-7B-Instruct', object: 'model', owned_by: 'local' }]
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await new Promise<string>((resolve, reject) => {
      let buf = '';
      req.on('data', d => (buf += d));
      req.on('end', () => resolve(buf));
      req.on('error', reject);
    });
    const parsed: ChatCompletionRequest = JSON.parse(body);

    // Decide streaming mode
    const stream = !!parsed.stream;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      // 1) Emit an initial chunk (OpenAI-style)
      writeSse(res, {
        id: 'chatcmpl-local',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      // 2) Stream tokens from your backend. Replace this loop with your generator.
      for await (const token of fakeTokenStreamFromBackend(parsed)) {
        writeSse(res, {
          id: 'chatcmpl-local',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model,
          choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
        });
      }

      // 3) Final chunk + DONE marker
      writeSse(res, {
        id: 'chatcmpl-local',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        // usage: { prompt_tokens: ..., completion_tokens: ..., total_tokens: ... } // optional
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    } else {
      // Non-streaming response
      const text = await fakeSingleShotFromBackend(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-local',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        }],
      }));
      return;
    }
  }

  res.writeHead(404);
  res.end();
}).listen(8001);

async function* fakeTokenStreamFromBackend(_req: ChatCompletionRequest) {
  yield 'Hello ';
  yield 'from ';
  yield 'local ';
  yield 'Qwen.';
}

async function fakeSingleShotFromBackend(_req: ChatCompletionRequest) {
  return 'Hello from local Qwen.';
}
```

This proxy deliberately targets the OpenAI-ish surface Copilot Chat’s BYOK endpoints are built around. citeturn25view0turn15view1turn14view1

### Tool calling compatibility notes for agent-mode parity

Agent mode is implemented as a loop over tool calls, and the tools are declared in `package.json` and implemented in `src/extension/tools/node`. The repo explicitly points to `toolCallingLoop.ts` as the agentic loop and describes how tools are selected and passed to the agent. citeturn21view0turn22view1

For “comparable successful results” in agent mode, your local Qwen server must either:

- support (or be shimmed to support) OpenAI function tool calling, **and** return tool calls with JSON argument strings, or  
- be marked as not supporting tool calling so VS Code doesn’t try to use it for agent mode/tool-heavy flows (VS Code doc notes agent-mode model list is limited to models that support tool calling). citeturn20search6turn14view1turn15view2

## Performance engineering, evaluation plan, and security/privacy implications

### Latency and throughput strategy for local inference

To keep Copilot Chat UX usable, you generally need:

- **fast time-to-first-token** for streaming UX
- stable token throughput during long tool-heavy turns
- predictable context window budgeting to avoid over-pruning

The Qwen team recommends vLLM for deployment and highlights batching and attention-memory efficiency features (PagedAttention, continuous batching). citeturn27view1turn26search2

Within the extension, token budgeting happens before sending the request, so misconfigured `maxInputTokens` and tokenizer mismatch will manifest as missing context rather than slower inference. citeturn14view1turn15view0turn15view2

Practical tactics:

- If you use vLLM: tune `--max-model-len` to a realistic value for your workflow to control KV cache memory pressure; Qwen docs discuss OOM mitigation, including lowering `--max-model-len` and adjusting utilization. citeturn27view1turn27view0  
- If you use Ollama: validate server compatibility version (Copilot Chat’s provider enforces a minimum version and will error otherwise). citeturn24view3  
- If you implement your own proxy: implement streaming with small, frequent deltas; the wrapper surfaces deltas directly to the UI. citeturn14view1turn15view1

### Evaluation metrics and a testing plan

The repository includes three test tiers and is explicit that simulation tests are expensive and cached:

- unit tests (`npm run test:unit`)
- extension integration tests (`npm run test:extension`)
- simulation tests (`npm run simulate`) that hit real endpoints and snapshot results in `test/simulation/baseline.json` with cached layers in `test/simulation/cache`. citeturn21view0

A pragmatic evaluation plan for “comparable results”:

- **Functional correctness**
  - pass rate of generated code on unit tests in the target repo
  - compilation success / lint pass rate
- **Agentic success rate**
  - % of tasks completed without human intervention
  - tool-call correctness (right tool, correct args schema, low retry count)
- **Context efficiency**
  - token budget utilization (prompt vs tool schema vs output)
  - rate of prompt pruning (number of pruned prompt parts per request)

Two strong built-in observability tools the repo recommends:

- “Show Chat Debug View” to inspect prompts, enabled tools, full responses, and tool calls. citeturn21view0  
- request logging and export workflows mentioned in contributing docs (with a privacy warning about sensitive content). citeturn21view0

### Fallback strategies

You should plan for:

- **Local server unavailable**: fall back to Copilot base model by switching model (the extension already does model switching for quota scenarios). citeturn12view2turn24view0  
- **Tool calling unreliable**: disable tool calling capability in the model metadata so it won’t be used for agent mode; keep it available for “Ask” usage. citeturn20search6turn15view2  
- **Streaming unreliable**: mark `supports.streaming=false` in model capabilities so the system tries non-stream parsing. citeturn15view2  
- **Context pressure**: enable “large tool results to disk” behavior and reduce toolset size; the repo includes explicit settings to control tool-result context bloat. citeturn10view0

### Security and privacy implications of local model use

Key security facts visible in repo and official docs:

- The contributing guide warns that request logs/debug view may contain personal information (file contents, terminal output) and should be reviewed before sharing. citeturn21view0  
- VS Code’s BYOK guidance notes that Copilot service APIs may still be used for tasks such as embeddings, repository indexing, intent detection, and side queries, and that responsible AI filtering may not apply to third-party model outputs. citeturn20search6turn13search4  
- The BYOK OpenAI-compatible endpoint implementation includes strict sanitization and blocking of reserved/forbidden headers to prevent header injection and to preserve security and functionality boundaries (e.g., blocking overrides for `authorization`, forwarding headers, and others). citeturn25view0turn5view3

Implications for a local Qwen setup:

- **Data locality improves** for the primary generation request (code context stays on your machine *if your inference server is local*), but **data still flows** to other services depending on features you use (embeddings, code search, etc.). citeturn20search6turn13search4  
- If you run your local server on `0.0.0.0` or a LAN host, treat it as a sensitive service:
  - require an auth token (even a simple one) if the port is reachable by others,
  - restrict CORS and bind to localhost where possible,
  - log sparingly (requests can contain proprietary code).
- If you enable tool calling, tool schemas and tool results may contain highly sensitive workspace data; the extension can include tool results directly in prompts unless configured otherwise. citeturn10view0turn22view1

### Timeline checklist

**Architecture alignment**
- Read `CONTRIBUTING.md` sections on layers, runtimes, and the prompt system; confirm which runtime target you care about first (Node vs web worker). citeturn21view0turn22view2  
- Identify your hook point: BYOK provider vs endpoint provider override.

**Local model bring-up**
- Choose serving stack (vLLM vs Ollama vs llama.cpp) that matches OpenAI chat compatibility. citeturn27view1turn24view3turn26search3  
- Validate `/v1/models` and `/v1/chat/completions` (streaming and non-streaming).

**Copilot Chat integration**
- Register as a model provider (BYOK provider inside repo or via VS Code language models editor) and verify the model appears as non-copilot vendor and routes via `ExtensionContributedChatEndpoint`. citeturn24view0turn20search6  
- Set correct token limits (avoid accidental small budgets vs Qwen’s long-context expectations). citeturn27view0turn14view1

**Agent-mode parity work**
- Decide whether you will support tool calling; if yes, confirm tool-call JSON arguments are valid and streaming tool call deltas work end-to-end. citeturn14view1turn21view0turn22view1  
- If no, explicitly mark tool calling unsupported in metadata and validate non-agent chat quality.

**Evaluation and hardening**
- Use “Show Chat Debug View” to compare prompt payloads and responses between Copilot-hosted models and your local Qwen model. citeturn21view0  
- Add regression scenarios using the repo’s simulation test approach (or a parallel harness if you can’t populate official caches). citeturn21view0  
- Add fallback behavior on local server failure and document security boundaries (localhost binding, token auth, logging hygiene). citeturn15view0turn25view0turn12view2