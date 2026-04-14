# ADR-001: Intent Extraction and Tool Selection Strategy

## Status

Accepted — 2026-02-23

## Context

The agent was anchoring intent to surrounding log noise rather than the specific
error signal, which caused incorrect fixes. For example, a browser 404 error for
`explosion.png` was diagnosed as a path-prefix problem, leading the agent to
prepend `/assets/` to every asset path instead of finding or creating the missing
file.

Two compounding failures were observed:

1. **Coarse intent lock** — intent was extracted from the first line of a
   multi-line error dump (which happened to be a navigation log) instead of from
   the 404 URL buried in that dump.

2. **Wrong tool subset** — without a `missing-resource` intent, filesystem tools
   (`listDirectory`, `searchFiles`) were not selected in the first pass, so the
   agent never discovered that the file was absent.

## Decision

### Intent extraction (`src/intent/intentExtractor.ts`)

- Apply an ordered list of regex patterns to the user message before any other
  processing. Patterns are sorted by specificity: missing-resource errors first,
  then build failures, then syntax/runtime errors.
- Lock intent to the **most specific signal** extracted — e.g. the failing URL
  for a 404, the module name for a missing-import error.
- Allow mid-session refinement via `maybeRefineIntent` when tool results
  contradict the locked intent.
- Treat the user's own stated root cause as authoritative; do not override it.

### Tool selection (`src/tools/toolSelector.ts`)

- Maintain an explicit `INTENT_TOOL_MAP` from `IntentType` to prioritised tool
  names.
- For `missing-resource` intents, always include `listDirectory`, `searchFiles`,
  `createFile` in the first pass.
- Re-select tools fresh each turn — no stale carry-over.
- Log the selection rationale (intent type, anchor, selected tools) for
  observability.

### Session tracking (`src/agent/sessionTracker.ts`)

- Track `mutationCount` per turn — only calls to known mutation tools
  (`editFile`, `createFile`, `runCommand`, …) increment this counter.
- After two consecutive zero-mutation turns, inject an escalation prompt that
  forces the model to act rather than diagnose again.
- Gate post-mutation verification on `totalMutations > 0`.

### Execution anchor (`src/prompt/executionAnchor.ts`)

- Inject a compact (~300-token) structured header at the top of every LLM prompt
  carrying: original request, locked intent, latest tool evidence, session
  summary.
- This prevents the model from losing the error signal as context grows.

## Consequences

- Fixes are scoped to the actual failing resource rather than the surrounding context.
- Intent is stable across turns but can be refined when evidence warrants it.
- Zero-progress loops are detected and broken within two turns.
- All intent and tool-selection decisions are logged with rationale.
- New modules are independently testable and have no circular dependencies.

## Trade-offs

- The regex pattern list must be maintained as new error formats are encountered.
- The `INTENT_TOOL_MAP` is a static heuristic; edge cases may require a new
  `IntentType` variant.
- Escalation prompt injection modifies the message array in-place — callers must
  be aware this mutates the conversation history.
