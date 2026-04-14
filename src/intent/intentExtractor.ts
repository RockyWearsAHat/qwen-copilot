/**
 * @module intentExtractor
 *
 * Extracts a structured, actionable intent from raw user input.
 *
 * Design goals:
 *  - Prioritise explicit error signals (404, TypeError, build failures) over
 *    surrounding log noise.
 *  - Allow intent to be refined mid-session when new tool evidence contradicts
 *    the originally-locked intent.
 *  - Treat the user's own stated root cause as authoritative — do not override
 *    it with model inference.
 */

/** Discriminated union of every error / task category the agent can recognise. */
export type IntentType =
  | "missing-resource" // 404, failed fetch, missing file/module
  | "syntax-error" // parse / compile-time error
  | "runtime-error" // TypeError, ReferenceError, uncaught exception
  | "build-failure" // bundler / compiler build-step failure
  | "feature-request" // user asking to add / change behaviour
  | "general"; // catch-all when no specific pattern matches

/**
 * A locked intent object carried through every turn of an agent session.
 *
 * `anchor` is the most specific signal extracted from the user message —
 * e.g. the failing URL for a 404, or the module name for a missing-module
 * error.  The agent should scope its first tool call to resolving `anchor`
 * exactly.
 */
export interface LockedIntent {
  type: IntentType;
  /**
   * The most specific signal extracted — e.g. failing URL, error message text,
   * or module name.  Used as the primary investigation target each turn.
   */
  anchor: string;
  /** Preserved verbatim for fallback context and logging. */
  rawInput: string;
}

/** Ordered list of patterns tried against the user message. First match wins. */
const ERROR_PATTERNS: Array<{ pattern: RegExp; type: IntentType }> = [
  // Missing resources — most common and most actionable, checked first
  { pattern: /GET "([^"]+)" 404/, type: "missing-resource" },
  { pattern: /GET ([^\s]+) 404/, type: "missing-resource" },
  { pattern: /Failed to load resource[^:]*:\s*(.+)/, type: "missing-resource" },
  { pattern: /Cannot find module '([^']+)'/, type: "missing-resource" },
  { pattern: /Module not found[^']*'([^']+)'/, type: "missing-resource" },
  { pattern: /ENOENT[^:]*:\s*no such file[^']*'([^']+)'/, type: "missing-resource" },
  { pattern: /net::ERR_FILE_NOT_FOUND\s+([^\s]+)/, type: "missing-resource" },

  // Build failures
  { pattern: /Build failed[:\s]+(.+)/i, type: "build-failure" },
  { pattern: /error TS\d+:\s*(.+)/, type: "build-failure" },
  { pattern: /Compilation error[:\s]+(.+)/i, type: "build-failure" },

  // Syntax errors
  { pattern: /SyntaxError[:\s]+(.+)/, type: "syntax-error" },
  { pattern: /Unexpected token[:\s]+(.+)/, type: "syntax-error" },

  // Runtime errors
  { pattern: /TypeError[:\s]+(.+)/, type: "runtime-error" },
  { pattern: /ReferenceError[:\s]+(.+)/, type: "runtime-error" },
  { pattern: /Uncaught[:\s]+(.+)/, type: "runtime-error" },
];

function extractConcreteMissingResourceAnchor(input: string): string | undefined {
  const explicitFieldMatches = [
    ...Array.from(
      input.matchAll(/(?:currentsrc|src|srcelement|imgtarget)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi),
    ).map((m) => m[1]),
    ...Array.from(input.matchAll(/<img\s+src=["']([^"']+)["']/gi)).map((m) => m[1]),
  ];

  const urlMatches = Array.from(input.matchAll(/https?:\/\/[^\s"'`<>]+/gi)).map((m) => m[0]);
  const pathMatches = Array.from(
    input.matchAll(/\/[^\s"'`<>]+\.[a-zA-Z]{2,5}(?:\?[^\s"'`<>]*)?/g),
  ).map((m) => m[0]);
  const fileMatches = Array.from(input.matchAll(/\b[\w.-]+\.[a-zA-Z]{2,5}\b/g)).map((m) => m[0]);

  const candidates = [...explicitFieldMatches, ...urlMatches, ...pathMatches, ...fileMatches]
    .map((v) => v.trim().replace(/[)\]}>.,;:!?]+$/g, ""))
    .filter((v) => v.length > 0)
    .filter((v) => !/w3\.org\/1999\/xhtml/i.test(v));

  if (candidates.length === 0) {
    return undefined;
  }

  // Prefer concrete path-like artifacts over bare filenames.
  const pathLike = candidates.find((v) => /\/[^\s"'`<>]+\.[a-zA-Z]{2,5}(\?|#|$)/.test(v));
  if (pathLike) {
    return pathLike;
  }

  const fileLike = candidates.find((v) => /^[\w.-]+\.[a-zA-Z]{2,5}$/.test(v));
  if (fileLike) {
    return fileLike;
  }

  return undefined;
}

/**
 * Parses a raw user message and returns a {@link LockedIntent} anchored to
 * the most specific error signal found.
 *
 * Falls back to `'general'` with the first line of the message as the anchor
 * when no known error pattern matches.
 *
 * @param userMessage - Raw text from the user's chat message.
 * @returns A {@link LockedIntent} to carry through the session.
 */
export function extractIntent(userMessage: string): LockedIntent {
  for (const { pattern, type } of ERROR_PATTERNS) {
    const match = userMessage.match(pattern);
    if (match) {
      return {
        type,
        anchor: match[1].trim(),
        rawInput: userMessage,
      };
    }
  }

  const looksLikeMissingResource =
    /\b(404|failed to load|not found|enoent|missing|asset|img|currentsrc|srcelement|imgtarget)\b/i.test(
      userMessage,
    );
  if (looksLikeMissingResource) {
    const concrete = extractConcreteMissingResourceAnchor(userMessage);
    return {
      type: "missing-resource",
      anchor: concrete ?? "missing-resource",
      rawInput: userMessage,
    };
  }

  return {
    type: "general",
    anchor: userMessage.split("\n")[0].trim(),
    rawInput: userMessage,
  };
}

/**
 * Re-evaluates a previously locked intent against newly arrived tool-result
 * evidence.  Only refines the intent when the evidence clearly contradicts the
 * current lock (e.g. the originally-suspected missing file turns out to exist).
 *
 * Keeps the original intent stable when evidence is ambiguous — stability is
 * preferred over thrashing.
 *
 * @param current          - The intent locked at the start of the session.
 * @param toolResultSummary - A short summary of the most recent tool result.
 * @returns Either the same intent or a newly refined one.
 */
export function maybeRefineIntent(current: LockedIntent, toolResultSummary: string): LockedIntent {
  if (current.type === "missing-resource") {
    // If tool result shows the anchor resource clearly exists, the original
    // diagnosis was wrong — re-extract from the tool result itself.
    const fileExistsSignal = /\bfound\b|\bexists\b|\b200\b|\bloaded\b/i.test(toolResultSummary);
    if (fileExistsSignal) {
      return extractIntent(toolResultSummary);
    }
  }

  return current;
}
