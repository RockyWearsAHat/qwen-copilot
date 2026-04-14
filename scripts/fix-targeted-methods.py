#!/usr/bin/env python3
"""
Fix the remaining broken methods in localLanguageModelProvider.ts.
These methods have delegation stubs injected inside their inline parameter types.
This script finds each broken method using paren-tracking and replaces with clean stubs.
"""

import re
import sys

FILE = "src/llm/localLanguageModelProvider.ts"

# Full clean delegation stubs for each remaining broken method
CLEAN_STUBS = {
    "private async selectToolsViaLookupGate(": """\
  private async selectToolsViaLookupGate(
    requestBase: {
      endpoint: string;
      model: string;
      temperature: number;
      contextWindowTokens: number;
      maxOutputTokens: number;
      messages: LlmMessage[];
      requestKey: string;
      primaryTaskText: string;
    },
    availableTools: readonly LlmToolSpec[],
    abortController: AbortController,
  ): Promise<LlmToolSpec[]> {
    return this.toolLookupGate.selectToolsViaLookupGate(requestBase, availableTools, abortController);
  }""",
}


def find_method_extent(content: str, method_prefix: str):
    """
    Find the start and end of a method in content, using paren-tracking
    to properly handle inline object types in parameters.
    Returns (method_start_idx, method_end_idx) or (None, None).
    """
    search_str = re.escape(method_prefix.lstrip())
    match = re.search(r'\n(\s+)' + search_str, content)
    if not match:
        return None, None

    method_start = match.start()

    # Track parens from right after the opening '(' of the method
    # (match.end() is right after the opening '(' because the prefix ends with '(')
    pos = match.end()
    paren_depth = 1  # we're inside the outer (

    body_start = None

    while pos < len(content):
        ch = content[pos]
        if ch == '(':
            paren_depth += 1
        elif ch == ')':
            paren_depth -= 1
            if paren_depth == 0:
                # Params are done. Find the opening brace of the method body.
                rest_after_close = content[pos + 1:]
                brace_match = re.search(r'\{', rest_after_close)
                if brace_match:
                    body_start = pos + 1 + brace_match.start()
                break
        pos += 1

    if body_start is None:
        # Handle methods with no explicit parameter list end (rare)
        brace_match = re.search(r'\{', content[match.end():])
        if brace_match:
            body_start = match.end() + brace_match.start()
        else:
            return None, None

    # Count braces from body_start to find the method end
    depth = 1
    pos = body_start + 1
    while pos < len(content) and depth > 0:
        ch = content[pos]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        pos += 1

    if depth != 0:
        return None, None

    return method_start, pos


with open(FILE, "r") as f:
    content = f.read()

original_lines = content.count('\n')
fixed_count = 0

for prefix, stub in CLEAN_STUBS.items():
    start, end = find_method_extent(content, prefix)
    if start is None:
        print(f"  NOT FOUND: {prefix.strip()}")
        continue

    # Verify it's actually broken (delegation stub injected into params)
    signature_area = content[start:end]
    if "return this." in signature_area[:200]:
        print(f"  FIXING: {prefix.strip()}")
    else:
        print(f"  (already clean, re-writing anyway): {prefix.strip()}")

    content = content[:start] + "\n" + stub + content[end:]
    fixed_count += 1

with open(FILE, "w") as f:
    f.write(content)

new_lines = content.count('\n')
print(f"\nReplaced {fixed_count}/{len(CLEAN_STUBS)} methods")
print(f"Lines: {original_lines} → {new_lines}")
