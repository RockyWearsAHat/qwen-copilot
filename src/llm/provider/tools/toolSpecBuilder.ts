import type * as vscode from "vscode";
import type { LlmToolSpec } from "../../ollamaClient";

export interface ToolSpecProfile {
  maxToolDescriptionChars: number;
}

export class ToolSpecBuilder {
  private readonly toolSpecCache = new Map<string, LlmToolSpec[]>();

  public toOllamaToolSpecs(
    tools: readonly vscode.LanguageModelChatTool[],
    performanceProfile: ToolSpecProfile,
    compactSchema: boolean,
    namesOnly: boolean,
  ): LlmToolSpec[] {
    const cacheKey = this.buildToolSpecCacheKey(
      tools,
      performanceProfile,
      compactSchema,
      namesOnly,
    );
    const cached = this.toolSpecCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let mapped: LlmToolSpec[];
    if (namesOnly) {
      mapped = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: `Tool '${tool.name}'`,
          parameters: {
            type: "object",
            additionalProperties: true,
          },
        },
      }));
      this.toolSpecCache.set(cacheKey, mapped);
      return mapped;
    }

    const defaultParams: Record<string, unknown> = {
      type: "object",
      additionalProperties: true,
    };

    mapped = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: compactSchema
          ? this.compactToolDescription(
              tool.description,
              performanceProfile.maxToolDescriptionChars,
            )
          : tool.description,
        parameters: compactSchema
          ? (this.compactJsonSchema(
              (tool.inputSchema ?? defaultParams) as Record<string, unknown>,
            ) as Record<string, unknown>)
          : ((tool.inputSchema ?? defaultParams) as Record<string, unknown>),
      },
    }));

    this.toolSpecCache.set(cacheKey, mapped);
    return mapped;
  }

  private buildToolSpecCacheKey(
    tools: readonly vscode.LanguageModelChatTool[],
    performanceProfile: ToolSpecProfile,
    compactSchema: boolean,
    namesOnly: boolean,
  ): string {
    const signature = tools
      .map((tool) => {
        const schemaPropertyCount = this.countSchemaProperties(tool.inputSchema);
        return `${tool.name}:${tool.description.length}:${schemaPropertyCount}`;
      })
      .join("|");

    return [
      namesOnly ? "names" : "full",
      compactSchema ? "compact" : "raw",
      String(performanceProfile.maxToolDescriptionChars),
      String(tools.length),
      signature,
    ].join("::");
  }

  private countSchemaProperties(schema: unknown): number {
    if (!schema || typeof schema !== "object") {
      return 0;
    }

    const record = schema as { properties?: unknown };
    if (!record.properties || typeof record.properties !== "object") {
      return 0;
    }

    return Object.keys(record.properties as Record<string, unknown>).length;
  }

  private compactToolDescription(description: string, maxToolDescriptionChars: number): string {
    const normalized = description.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }

    return normalized.slice(0, maxToolDescriptionChars);
  }

  private compactJsonSchema(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.slice(0, 8).map((entry) => this.compactJsonSchema(entry));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const schema = value as Record<string, unknown>;
    const compact: Record<string, unknown> = {};
    const allowedKeys = new Set([
      "type",
      "description",
      "properties",
      "required",
      "items",
      "enum",
      "oneOf",
      "anyOf",
      "allOf",
      "additionalProperties",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "pattern",
      "format",
      "default",
    ]);

    for (const [key, raw] of Object.entries(schema)) {
      if (!allowedKeys.has(key)) {
        continue;
      }

      if (key === "default" && typeof raw === "string") {
        compact[key] = raw.slice(0, 80);
        continue;
      }

      compact[key] = this.compactJsonSchema(raw);
    }

    return compact;
  }
}
