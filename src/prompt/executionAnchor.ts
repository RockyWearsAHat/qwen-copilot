/**
 * @module executionAnchor
 *
 * Builds a compact, structured execution-anchor header injected at the top of
 * every LLM prompt.
 *
 * Design goals:
 *  - Ensure the model always has: original request + current locked intent +
 *    latest tool-result evidence + session progress summary.
 *  - Surface the current plan step and already-visited files so the model can
 *    make workspace-aware decisions instead of re-reading known content.
 *  - Keep the header under ~400 tokens so it does not crowd out tool schemas.
 *  - Make the success condition explicit so the model is driven by objective
 *    completion rather than reactive constraints.
 */

import type { LockedIntent } from "../intent/intentExtractor";

/**
 * All data required to build one execution anchor.
 *
 * Every field is intentionally capped at source to avoid token bloat.
 */
export interface AnchorContext {
  /**
   * The original user request, verbatim.
   * Capped to 200 characters in the rendered output.
   */
  originalRequest: string;

  /** The intent locked at the start of the session (may have been refined). */
  lockedIntent: LockedIntent;

  /**
   * A brief summary of the most recent tool result.
   * Capped to 800 characters to give the model enough context to reason.
   */
  latestEvidence: string;

  /**
   * Single-line session progress summary from {@link SessionTracker.getSummary}.
   * E.g. `"turns=2 total_mutations=1 stuck=false"`.
   */
  sessionSummary: string;

  /** Absolute workspace root path on disk, when available. */
  workspaceRoot?: string;

  /**
   * Rationale for the current plan step, derived from the pre-flight planning
   * turn.  When set, the model is reminded which step it should be executing.
   */
  currentPlanStep?: string;

  /**
   * Absolute paths of files already read in this session.  The model uses
   * this to avoid re-reading files it already has context on.
   */
  filesVisited?: readonly string[];
}

/**
 * Builds a compact Markdown execution-anchor header for injection into the
 * system or user message at the start of each turn.
 *
 * @param ctx - Anchor context for the current turn.
 * @returns   Multi-line Markdown string ready to prepend to a prompt message.
 */
export function buildExecutionAnchor(ctx: AnchorContext): string {
  const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

  const lines = [
    `**Task:** ${truncate(ctx.originalRequest, 200)}`,
    `**Focus:** [${ctx.lockedIntent.type}] ${truncate(ctx.lockedIntent.anchor, 150)}`,
    `**Last result:** ${truncate(ctx.latestEvidence, 800)}`,
    `**Session:** ${ctx.sessionSummary}`,
  ];

  if (ctx.workspaceRoot) {
    lines.push(
      `**Workspace root:** ${truncate(ctx.workspaceRoot, 220)}`,
      "**Assume this workspace is already open; do not open/switch folders unless explicitly requested.**",
    );
  }

  if (ctx.currentPlanStep) {
    lines.push(`**Current plan step:** ${truncate(ctx.currentPlanStep, 200)}`);
  }

  if (ctx.filesVisited && ctx.filesVisited.length > 0) {
    // Show only the file basenames to keep the anchor compact.
    const basenames = ctx.filesVisited.map((p) => p.split(/[\\/]/).pop() ?? p);
    lines.push(`**Files already read:** ${basenames.slice(0, 20).join(", ")}`);
  }

  return lines.join("\n");
}
