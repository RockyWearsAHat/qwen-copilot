"use strict";
/**
 * @module systemPrompt
 *
 * Single source of truth for the system prompt injected into every LLM request.
 * Composition is delegated to modular section builders for maintainability.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSystemPrompt = buildSystemPrompt;
const systemPromptSections_1 = require("./systemPromptSections");
/**
 * Builds the complete system prompt for a request.
 *
 * Principle: tell the model what it needs to know about its environment,
 * then get out of the way. The model's training handles the rest.
 * Do NOT add rules that try to substitute for the model's own reasoning.
 */
function buildSystemPrompt(ctx = {}) {
    const lines = [...(0, systemPromptSections_1.buildSystemPromptCoreSections)()];
    // Default behavior: for complex tasks, follow a plan + checklist + loop
    // workflow so you make steady, verifiable progress instead of ad-hoc edits.
    if (ctx.enablePlanningAndChecklists !== false) {
        lines.push(...(0, systemPromptSections_1.buildPlanningChecklistSection)());
    }
    if (ctx.isPackageManagement) {
        lines.push("- For dependency changes: read the relevant config file first, then run a single targeted install command.");
    }
    return lines.join("\n");
}
//# sourceMappingURL=systemPrompt.js.map