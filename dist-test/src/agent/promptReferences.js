"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderPromptReferencesContext = renderPromptReferencesContext;
const vscode = __importStar(require("vscode"));
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n\n… (truncated to ${maxChars} chars)`;
}
function looksLikeUri(value) {
    const v = value;
    return !!v && typeof v.scheme === "string" && typeof v.toString === "function";
}
function looksLikeLocation(value) {
    const v = value;
    return (!!v &&
        typeof v.uri === "object" &&
        looksLikeUri(v.uri) &&
        typeof v.range === "object" &&
        typeof v.range.start === "object" &&
        typeof v.range.end === "object");
}
function formatLocation(value) {
    const start = value.range.start;
    const end = value.range.end;
    // VS Code ranges are 0-based. Humans read 1-based.
    const startLine = start.line + 1;
    const startChar = start.character + 1;
    const endLine = end.line + 1;
    const endChar = end.character + 1;
    return `${value.uri.toString(true)}#L${startLine}:${startChar}-L${endLine}:${endChar}`;
}
/**
 * Renders Copilot/VS Code prompt references (user-attached context like files/locations)
 * into a compact system-message payload. This is intentionally simple and truncated.
 */
async function renderPromptReferencesContext(references, options = {}) {
    if (!references || references.length === 0)
        return "";
    const maxTotalChars = options.maxTotalChars ?? 12_000;
    const maxCharsPerReference = options.maxCharsPerReference ?? 4_000;
    const chunks = [
        "## Copilot Prompt References (user-attached context)",
        "These are values the user referenced/attached in the Copilot prompt UI.",
        "Prefer using them over searching the workspace.",
        "",
    ];
    let used = chunks.join("\n").length;
    for (const ref of references) {
        if (used >= maxTotalChars)
            break;
        const headerLines = [
            `### ${ref.id}`,
            ...(ref.modelDescription ? [`**description:** ${ref.modelDescription}`] : []),
        ];
        let body = "";
        try {
            if (typeof ref.value === "string") {
                body = truncate(ref.value, maxCharsPerReference);
            }
            else if (looksLikeLocation(ref.value)) {
                const loc = ref.value;
                const doc = await vscode.workspace.openTextDocument(loc.uri);
                body = truncate(doc.getText(loc.range), maxCharsPerReference);
                headerLines.push(`**location:** ${formatLocation(loc)}`);
            }
            else if (looksLikeUri(ref.value)) {
                const uri = ref.value;
                const doc = await vscode.workspace.openTextDocument(uri);
                body = truncate(doc.getText(), maxCharsPerReference);
                headerLines.push(`**file:** ${uri.toString(true)}`);
            }
            else {
                // Future-proof: render unknown values as JSON-ish.
                body = truncate(String(ref.value), maxCharsPerReference);
            }
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            body = `Unable to resolve reference value: ${msg}`;
        }
        const block = [...headerLines, "", body, ""].join("\n");
        if (used + block.length > maxTotalChars) {
            const remaining = Math.max(0, maxTotalChars - used);
            chunks.push(truncate(block, remaining));
            used = maxTotalChars;
            break;
        }
        chunks.push(block);
        used += block.length;
    }
    const rendered = chunks.join("\n").trim();
    return rendered.length > maxTotalChars ? truncate(rendered, maxTotalChars) : rendered;
}
//# sourceMappingURL=promptReferences.js.map