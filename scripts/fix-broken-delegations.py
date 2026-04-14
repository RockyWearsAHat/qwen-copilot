#!/usr/bin/env python3
"""
Fix mangled methods in localLanguageModelProvider.ts.
The previous delegation script broke methods that have inline object types in parameters.
This script uses git to get the original signatures and fixes them properly.
"""

import subprocess
import re
import sys

FILE = "src/llm/localLanguageModelProvider.ts"

# Get original file from git
result = subprocess.run(
    ["git", "show", "HEAD:src/llm/localLanguageModelProvider.ts"],
    capture_output=True, text=True
)
original = result.stdout

# Minimal set of DELEGATIONS for broken methods only (methods with inline object types in params)
# These need special treatment since the previous script mangled them
BROKEN_DELEGATIONS = {
    "private async selectToolsViaLookupGate(": 
        "return this.toolLookupGate.selectToolsViaLookupGate(requestBase, availableTools, abortController);",
    "private async deriveLookupIntentQuery(":
        "return this.toolLookupGate.deriveLookupIntentQuery(requestBase, latestUserMessage, abortController, _lookupTimeoutMs);",
    "private async summarizeConversationForContinuation(":
        "return this.messageCompactor.summarizeConversationForContinuation(endpoint, model, temperature, contextWindowTokens, messages, lockedIntent, abortController);",
    "private async fetchModelInfos(":
        "return this.modelRegistry.fetchModelInfosInternal(endpoint, fallbackModel);",
    "private async hydrateMissingContextLengths(":
        "return this.modelRegistry.hydrateMissingContextLengths(models, endpoint, abortSignal, timeoutMs);",
    "private convertRequestMessage(":
        "return this.messageConverter.convertRequestMessage(message, compactEnvelopeMessages);",
    "private optimizeMessagesForLatency(":
        "return this.messageCompactor.optimizeMessagesForLatency(messages, performanceProfile);",
    "private shouldCompactContinuationMessages(":
        "return this.messageCompactor.shouldCompactContinuationMessages(messages, contextWindowTokens);",
    "private compactContinuationMessages(":
        "return this.messageCompactor.compactContinuationMessages(messages);",
    "private prioritizeToolsForIntent(":
        "return this.toolSelectionHelpers.prioritizeToolsForIntent(tools, messages);",
    "private selectInitialToolSubset(":
        "return this.toolSelectionHelpers.selectInitialToolSubset(tools, messages, performanceProfile);",
    "private ensureIntentRequiredTools(":
        "return this.toolSelectionHelpers.ensureIntentRequiredTools(selectedTools, availableTools, lockedIntent, this.isDeterministicComplianceHarnessMode());",
    "private rankToolsForLookup(":
        "return this.toolLookupGate.rankToolsForLookup(query, tools);",
    "private scoreToolsForLookup(":
        "return this.toolLookupGate.scoreToolsForLookup(query, tools);",
    "private selectModelLookupBypassTools(":
        "return this.toolLookupGate.selectModelLookupBypassTools(query, tools, maxResults);",
    "private alignToolCallsForLockedIntent(":
        "return this.pipeline.alignToolCallsForLockedIntent(toolCalls, allToolSpecs);",
    "private augmentBuildFixWithWorkspaceDiagnostics(":
        "return this.pipeline.augmentBuildFixWithWorkspaceDiagnostics(toolCalls, allToolSpecs);",
    "private preferPatchStyleMutationCalls(":
        "return this.pipeline.preferPatchStyleMutationCalls(toolCalls, allToolSpecs);",
    "private enforceBuildFixPostBuildProgression(":
        "return this.pipeline.enforceBuildFixPostBuildProgression(toolCalls, allToolSpecs);",
    "private buildPostMutationVerificationToolCalls(":
        "return this.pipeline.buildPostMutationVerificationToolCalls(allToolSpecs);",
    "private buildGuardrailFallbackToolCalls(":
        "return this.pipeline.buildGuardrailFallbackToolCalls(fullContent, allToolSpecs);",
    "private buildIntentAlignedFallbackToolCalls(":
        "return this.pipeline.buildIntentAlignedFallbackToolCalls(allToolSpecs);",
    "private optimizeToolCallBatchForExecution(":
        "return this.pipeline.optimizeToolCallBatchForExecution(toolCalls, allToolSpecs);",
}


def find_method_body(content, method_prefix):
    """Find start and end of a method body, handling all inline object types by 
    properly tracking the method signature vs body brace."""
    search = re.escape(method_prefix.lstrip())
    match = re.search(r'\n(\s+)' + search, content)
    if not match:
        return None, None, None
    
    indent = match.group(1)
    method_start = match.start()
    
    # We need to find the ACTUAL method body opening brace.
    # The method body starts with ): ReturnType { or { but NOT braces inside 
    # the parameter list or return type.
    # Strategy: track paren depth. When parens close to 0, find next { = body start.
    pos = match.end()
    # First, find the method's actual opening brace by tracking paren/angle depth
    paren_depth = 1  # we already saw the opening (
    angle_depth = 0
    
    # scan from match.end() (right after the opening paren of the method)
    # The match ends right after 'methodName(' so paren_depth=1 already
    body_start = None
    while pos < len(content):
        ch = content[pos]
        if ch == '(':
            paren_depth += 1
        elif ch == ')':
            paren_depth -= 1
            if paren_depth == 0:
                # Parameters are done. Now find the opening brace of the body.
                # Skip return type annotation (after : and before {)
                rest = content[pos+1:]
                brace_match = re.search(r'\{', rest)
                if brace_match:
                    body_start = pos + 1 + brace_match.start()
                break
        elif ch == '{' and paren_depth == 0:
            body_start = pos
            break
        pos += 1
    
    if body_start is None:
        return None, None, None
    
    # Now count braces from body_start to find method end
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
        return None, None, None
    
    return method_start, body_start, pos


with open(FILE, "r") as f:
    current = f.read()

fixed_count = 0
skipped = []

for prefix, stub in BROKEN_DELEGATIONS.items():
    # Get the original method from git HEAD 
    orig_start, orig_body_start, orig_end = find_method_body(original, prefix)
    if orig_start is None:
        skipped.append(f"NOT IN ORIGINAL: {prefix}")
        continue
    
    # Get the original signature (from method start to body opening brace inclusive)
    original_signature = original[orig_start:orig_body_start + 1]  # includes the '{'
    
    # Build the replacement: original signature + stub + closing brace
    indent_match = re.match(r'\n(\s+)', original_signature)
    indent = indent_match.group(1) if indent_match else "  "
    replacement = original_signature + f"\n{indent}  {stub}\n{indent}}}"
    
    # Find the mangled version in the current file and replace it
    curr_start, curr_body_start, curr_end = find_method_body(current, prefix)
    if curr_start is None:
        skipped.append(f"NOT IN CURRENT: {prefix}")
        continue
    
    # Check if it's actually broken (delegation inside the signature area)
    current_sig = current[curr_start:curr_body_start]
    is_broken = "return this." in current_sig or "return " in current_sig
    if is_broken:
        print(f"  FIXING (stub in sig): {prefix.strip()}")
    else:
        print(f"  REPLACING (clean): {prefix.strip()}")
    
    current = current[:curr_start] + replacement + current[curr_end:]
    fixed_count += 1

with open(FILE, "w") as f:
    f.write(current)

new_lines = current.count('\n')
print(f"\nFixed {fixed_count}/{len(BROKEN_DELEGATIONS)} methods.")
print(f"New line count: {new_lines}")
if skipped:
    print("\nSkipped:")
    for s in skipped:
        print(f"  {s}")
