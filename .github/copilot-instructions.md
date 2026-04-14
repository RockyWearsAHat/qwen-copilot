# Local LLM Plugin Agent Standards (No Hidden Guardrails)

**Audience:** AI coding agents (GitHub Copilot Chat / coding agents) working _on this repository_.

**Not a runtime config:** This extension does not load or execute this file to control its own behavior at runtime; it’s a workspace instructions/standards document (and some tests may validate its quality).

This repository is intentionally tuned for a “prompt-first” agent:

- Prefer stronger prompting + observable failures over runtime “fixups”.
- Do not silently reroute model intent (no hidden tool filtering, no silent tool-call rewrites/drops).
- When something is wrong: let the tool fail and surface the error/output.

## Mission

- Resolve the user’s request end-to-end with minimal, correct changes.
- Work in a tight loop: inspect → change → verify.
- Treat repeated diagnostic-only loops as a failure mode; pivot to concrete progress.

## No Hidden Guardrails (hard rules)

- Do not silently change the meaning of the model’s tool calls.
  - No “auto-correcting” file paths, commands, tool names, or arguments.
  - No dropping tool calls because they “look unsafe” or “not allowed”.
- If a tool call cannot run (missing required fields, tool not registered, disabled tool): return a clear error/result. Do not substitute a different action.
- Do not hide tools from the model to “improve outcomes”. Tool visibility changes are behavior shaping.

## Evidence-Based Environment Hints

It’s ok to provide environment facts, but only if they’re grounded.

- Good: “This repo appears to use Vite because `vite.config.ts` exists and `vite` is in `package.json`.”
- Bad: “Vite detected → therefore rewrite asset paths / infer `publicDir` / apply Vite rules.”

If you mention a framework/runtime/tooling, include the evidence you used (file names, config fields, or search hits). Prefer “appears to” over asserting certainty unless the evidence is explicit.

## Scope Discipline

- Treat explicit user constraints as authoritative (tools, paths, command shape, output format).
- Don’t substitute technologies or workflows unless the user asks.
- Keep edits tightly scoped to the request; avoid opportunistic refactors.

## Tooling Discipline

- Prefer tool calls over describing actions.
- Use the minimum number of tool calls for forward progress.
- Batch independent read-only operations (e.g., multiple `read_file` / `grep_search`) when possible.
- Don’t use the terminal for basic exploration if workspace tools suffice (`grep_search`, `file_search`, `list_dir`).

## Error-First Heuristics (be conclusive fast)

When the user reports an error/stack trace/log line, default to the **most conclusive** next step immediately:

- If it’s a compiler/linter/diagnostics error: call `get_errors` first (it gives exact file + location).
- If it’s a runtime error with a distinctive message/URL: `grep_search` the exact message (or a unique substring) to find the source and related code paths.
- If it’s fundamentally a UI/runtime-state issue and reproduction is feasible: use a visual repro flow (e.g. `open_simple_browser`, or machine interaction tools if enabled) to recreate it; otherwise fall back to code search.

Avoid “broad exploration” when a concrete anchor exists; use the anchor.

## Verification

- After any mutation (`apply_patch`, `create_file`, `edit_file`, `run_in_terminal` that changes state), verify:
  - Prefer `get_errors` for TypeScript/diagnostics.
  - Use a targeted test/build command when relevant (`npm test`, `npm run compile`).
- Report concrete verification outcomes (what ran, pass/fail, key errors).

## Few-shot examples

Use these as reference for what “correct” looks like.

---

### Example 1 — Missing file (404 / ENOENT)

**User message:**

```
GET "http://localhost:3000/assets/PNG/explosion.png" 404 (Not Found)
```

**Correct agent decision chain (error is still live):**

1. Extract intent: `missing-resource`, anchor = `explosion.png`
2. If visual tools are available: take a screenshot first to confirm the error is real right now.
3. Use `grep_search` or `read_file` on the source file that loads assets to find the reference.
4. If the code still references `explosion.png`: fix it to point to an existing file, then verify.

**Correct agent decision chain (error is stale):**

1. Extract intent: `missing-resource`, anchor = `explosion.png`
2. Read the source file that loads assets (e.g., `read_file` on the asset loader / game file).
3. The code says `grenade.png`, not `explosion.png` → the error anchor is **not present** in the source.
4. **Conclude stale immediately.** Do not `grep_search`, `list_dir`, or read more files — you already have the answer.
5. If visual tools are available: verify with a screenshot that the app works. Otherwise report: "The code now uses `grenade.png` which exists on disk. The error appears to be stale."

**Key principle:** Reading the relevant source file IS the stale check. If the anchor string isn't in the file you just read, the error is stale — act on that evidence immediately.

**Anti-pattern (wrong):**

- Continue exploring (`list_dir`, `grep_search`, reading more files) after the source file already showed a different path
- Add `/assets/` prefix to every path in the file because "paths look wrong"
- Run two+ diagnostic-only turns without touching any file or concluding stale

---

### Example 2 — Build / compile error

**User message:**

```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

**Correct agent decision chain:**

1. Extract intent: `build-failure`, anchor = `Argument of type 'string' is not assignable to parameter of type 'number'`
2. First tool call: `get_errors` to get the exact file and error location.
3. Use `read_file` scoped to the error range.
4. Fix the type mismatch with `apply_patch`.
5. Verify with `npm run compile` or `get_errors` again.

**Anti-pattern (wrong):**

- Read the entire file without targeting the diagnostic line
- Add a `// @ts-ignore` comment instead of fixing the type

---

### Example 3 — Feature request

**User message:**

```
Add a dark mode toggle to the settings page
```

**Correct agent decision chain:**

1. Extract intent: `feature-request`, anchor = `dark mode toggle settings page`
2. Use `file_search` / `grep_search` to find the settings component.
3. Use `read_file` on the relevant file(s) only.
4. Implement with `apply_patch` (minimal diff).
5. Verify with `get_errors` and any relevant tests.

**Anti-pattern (wrong):**

- Read every file in the project before starting
- Make partial implementations across multiple turns without completing each one

---

### Example 4 — Stuck escalation

After two consecutive turns with zero file mutations:

**Correct next action:**

- Pick the single most likely fix based on available evidence.
- Apply it immediately with `apply_patch`/`create_file`.
- Verify. If blocked, report the blocker and the next best action.

**Anti-pattern (wrong):**

- Ask clarifying questions that the user already answered in the original message
- Re-read the same files that were already read in turn 1
