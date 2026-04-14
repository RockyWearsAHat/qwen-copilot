"use strict";
/**
 * @module toolSelector
 *
 * Selects the minimum effective tool subset for the current agent intent.
 *
 * Design goals:
 *  - Re-select fresh every turn — no stale carry-over between turns.
 *  - Force filesystem discovery tools on the first turn for feature-request /
 *    general intents, before the agent edits anything it hasn't read.
 *  - Tool names must match the snake_case names produced by handlerReflection
 *    (i.e. the `tool_read_file` export becomes `read_file`).
 *  - Keep selection deterministic and logged so deviations are observable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectTools = selectTools;
/**
 * Returns a deduplicated, intent-relevant subset of `allTools`.
 *
 * When `alreadyVisited` is empty and the intent requires discovery first,
 * the returned list starts with discovery tools (`list_dir`, `file_search`)
 * so the LLM understands the workspace layout before touching any files.
 *
 * @param intent        - The currently locked session intent.
 * @param allTools      - Full pool of registered executable tools.
 * @param log           - Logging callback; receives a single formatted line.
 * @param alreadyVisited - Paths of files already read this session (optional).
 * @returns             Filtered subset ready to pass to the LLM request.
 */
function selectTools(intent, allTools, log, alreadyVisited = new Set()) {
    const selected = [...allTools];
    log(`[tool-selector] intent=${intent.type} visited=${alreadyVisited.size} ` +
        `anchor="${intent.anchor.slice(0, 80)}" ` +
        `selected=${selected.length}/${allTools.length} ` +
        `tools=[${selected.map((t) => t.name).join(", ")}]`);
    return selected;
}
//# sourceMappingURL=toolSelector.js.map