"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractToolNamesFromSource = extractToolNamesFromSource;
function extractToolNamesFromSource(source) {
    const discovered = new Set();
    const toolFunctionPattern = /\btool_([a-z0-9_]+)\b/g;
    const functionNamespacePattern = /functions\.([a-zA-Z0-9_-]+)/g;
    for (const match of source.matchAll(toolFunctionPattern)) {
        if (match[1]) {
            discovered.add(match[1]);
        }
    }
    for (const match of source.matchAll(functionNamespacePattern)) {
        if (match[1]) {
            discovered.add(match[1]);
        }
    }
    return discovered;
}
//# sourceMappingURL=toolNameExtraction.js.map