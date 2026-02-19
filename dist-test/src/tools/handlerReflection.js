"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reflectToolHandlers = reflectToolHandlers;
function reflectToolHandlers(handlerExports) {
    const map = new Map();
    for (const [exportName, value] of Object.entries(handlerExports)) {
        if (typeof value !== "function" || !exportName.startsWith("tool_")) {
            continue;
        }
        const toolName = exportName.slice("tool_".length);
        map.set(toolName, value);
    }
    return map;
}
//# sourceMappingURL=handlerReflection.js.map