import type { ToolCall } from "../llm/ollamaClient";

const TOOL_CALL_TAG = "local_qwen_tool_call";

type StructuredToolCallPayload =
  | {
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    }
  | { tool_calls?: unknown };

function toToolCallFromStructuredPayload(
  payload: unknown,
  nextId: () => string,
): ToolCall | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as StructuredToolCallPayload;

  const functionName =
    typeof (candidate as any).function?.name === "string"
      ? String((candidate as any).function.name).trim()
      : typeof (candidate as any).name === "string"
        ? String((candidate as any).name).trim()
        : "";

  if (!functionName) {
    return undefined;
  }

  const rawArgs =
    (candidate as any).function?.arguments ??
    (candidate as any).arguments ??
    (candidate as any).input;

  const normalizedArgs =
    typeof rawArgs === "string" ||
    (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
      ? (rawArgs as string | Record<string, unknown>)
      : {};

  return {
    id: nextId(),
    function: {
      name: functionName,
      arguments: normalizedArgs,
    },
  };
}

function toToolCallsFromStructuredPayload(payload: unknown, nextId: () => string): ToolCall[] {
  if (!payload) {
    return [];
  }

  // Accept { tool_calls: [...] }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const toolCalls = (payload as any).tool_calls;
    if (Array.isArray(toolCalls)) {
      return toolCalls
        .map((entry) => toToolCallFromStructuredPayload(entry, nextId))
        .filter((entry): entry is ToolCall => Boolean(entry));
    }
  }

  if (Array.isArray(payload)) {
    return payload
      .map((entry) => toToolCallFromStructuredPayload(entry, nextId))
      .filter((entry): entry is ToolCall => Boolean(entry));
  }

  const single = toToolCallFromStructuredPayload(payload, nextId);
  return single ? [single] : [];
}

export function extractTaggedTextToolCalls(params: {
  content: string;
  allowedToolNames: ReadonlySet<string>;
  nextId: () => string;
}): { cleanedContent: string; toolCalls: ToolCall[] } {
  const { content, allowedToolNames, nextId } = params;
  void allowedToolNames;

  const expression = new RegExp(`<${TOOL_CALL_TAG}>([\\s\\S]*?)<\\/${TOOL_CALL_TAG}>`, "gi");

  const matches = Array.from(content.matchAll(expression));
  if (matches.length === 0) {
    return { cleanedContent: content, toolCalls: [] };
  }

  const extracted: ToolCall[] = [];

  for (const match of matches) {
    const payloadText = match[1]?.trim();
    if (!payloadText) {
      continue;
    }

    try {
      const parsed = JSON.parse(payloadText) as unknown;
      const toolCalls = toToolCallsFromStructuredPayload(parsed, nextId);
      for (const toolCall of toolCalls) {
        extracted.push(toolCall);
      }
    } catch {
      continue;
    }
  }

  const cleaned = content.replace(expression, "").trim();

  return { cleanedContent: cleaned, toolCalls: extracted };
}

export function buildTextToolCallProtocolHint(toolNames: readonly string[]): string {
  const listed = toolNames.slice(0, 40).join(", ");
  return [
    "## Tool-call fallback (for models without native tool_calls)",
    "If you need to use tools, prefer outputting a single tagged JSON block:",
    `<${TOOL_CALL_TAG}>{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{...}}]}</${TOOL_CALL_TAG}>`,
    "Extra prose is allowed, but keeping it minimal reduces parsing ambiguity.",
    listed ? `Allowed tools this turn: ${listed}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
