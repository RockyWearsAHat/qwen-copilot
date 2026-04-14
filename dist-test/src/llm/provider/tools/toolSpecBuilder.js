"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolSpecBuilder = void 0;
class ToolSpecBuilder {
    toolSpecCache = new Map();
    toOllamaToolSpecs(tools, performanceProfile, compactSchema, namesOnly) {
        const cacheKey = this.buildToolSpecCacheKey(tools, performanceProfile, compactSchema, namesOnly);
        const cached = this.toolSpecCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        let mapped;
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
        const defaultParams = {
            type: "object",
            additionalProperties: true,
        };
        mapped = tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: compactSchema
                    ? this.compactToolDescription(tool.description, performanceProfile.maxToolDescriptionChars)
                    : tool.description,
                parameters: compactSchema
                    ? this.compactJsonSchema((tool.inputSchema ?? defaultParams))
                    : (tool.inputSchema ?? defaultParams),
            },
        }));
        this.toolSpecCache.set(cacheKey, mapped);
        return mapped;
    }
    buildToolSpecCacheKey(tools, performanceProfile, compactSchema, namesOnly) {
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
    countSchemaProperties(schema) {
        if (!schema || typeof schema !== "object") {
            return 0;
        }
        const record = schema;
        if (!record.properties || typeof record.properties !== "object") {
            return 0;
        }
        return Object.keys(record.properties).length;
    }
    compactToolDescription(description, maxToolDescriptionChars) {
        const normalized = description.replace(/\s+/g, " ").trim();
        if (!normalized) {
            return "";
        }
        return normalized.slice(0, maxToolDescriptionChars);
    }
    compactJsonSchema(value) {
        if (Array.isArray(value)) {
            return value.slice(0, 8).map((entry) => this.compactJsonSchema(entry));
        }
        if (!value || typeof value !== "object") {
            return value;
        }
        const schema = value;
        const compact = {};
        const allowedKeys = new Set([
            "type",
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
exports.ToolSpecBuilder = ToolSpecBuilder;
//# sourceMappingURL=toolSpecBuilder.js.map