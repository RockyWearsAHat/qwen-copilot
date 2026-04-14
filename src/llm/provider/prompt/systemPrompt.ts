/**
 * @module systemPrompt
 *
 * Single source of truth for the system prompt injected into every LLM request.
 * Composition is delegated to modular section builders for maintainability.
 */

import {
  buildPlanningChecklistSection,
  buildSystemPromptCoreSections,
} from "./systemPromptSections";

export interface SystemPromptContext {
  /** True when the request involves dependency installation. */
  isPackageManagement?: boolean;
  /** Locked intent text for this turn (unused but kept for call-site compat). */
  lockedIntent?: string;
  /** When true, enable the plan + checklist + loop workflow guidance. */
  enablePlanningAndChecklists?: boolean;
}

/**
 * Builds the complete system prompt for a request.
 *
 * Principle: tell the model what it needs to know about its environment,
 * then get out of the way. The model's training handles the rest.
 * Do NOT add rules that try to substitute for the model's own reasoning.
 */
export function buildSystemPrompt(ctx: SystemPromptContext = {}): string {
  const lines = [...buildSystemPromptCoreSections()];

  // Default behavior: for complex tasks, follow a plan + checklist + loop
  // workflow so you make steady, verifiable progress instead of ad-hoc edits.
  if (ctx.enablePlanningAndChecklists !== false) {
    lines.push(...buildPlanningChecklistSection());
  }

  if (ctx.isPackageManagement) {
    lines.push(
      "- For dependency changes: read the relevant config file first, then run a single targeted install command.",
    );
  }

  return lines.join("\n");
}
