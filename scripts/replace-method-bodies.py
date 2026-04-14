#!/usr/bin/env python3
"""
Replace extracted method bodies in localLanguageModelProvider.ts with delegation stubs.
This reduces the file from ~5400 lines to ~1300 lines while keeping it compilable.
"""

import re
import sys

FILE = "src/llm/localLanguageModelProvider.ts"

# Methods to replace with delegation stubs.
# Format: method_signature_prefix -> replacement_body
DELEGATIONS = {
    # ToolCallPipeline delegations
    "private parseToolArgs(": "return this.pipeline.parseToolArgs(toolCall);",
    "private compactToolCallBatch(": "return this.pipeline.compactToolCallBatch(toolCalls);",
    "private enforceBuildFixActionFirst(": "return this.pipeline.enforceBuildFixActionFirst(toolCalls);",
    "private redirectPiecemealEditsToReplace(": "return this.pipeline.redirectPiecemealEditsToReplace(compacted, _original);",
    "private optimizeToolCallBatchForExecution(": "return this.pipeline.optimizeToolCallBatchForExecution(toolCalls, allToolSpecs);",
    "private buildSearchToolCallFingerprint(": "return this.pipeline.buildSearchToolCallFingerprint(toolName, args);",
    "private buildGuardrailFallbackToolCalls(": "return this.pipeline.buildGuardrailFallbackToolCalls(fullContent, allToolSpecs);",
    "private buildIntentAlignedFallbackToolCalls(": "return this.pipeline.buildIntentAlignedFallbackToolCalls(allToolSpecs);",
    "private alignToolCallsForLockedIntent(": "return this.pipeline.alignToolCallsForLockedIntent(toolCalls, allToolSpecs);",
    "private augmentBuildFixWithWorkspaceDiagnostics(": "return this.pipeline.augmentBuildFixWithWorkspaceDiagnostics(toolCalls, allToolSpecs);",
    "private preferPatchStyleMutationCalls(": "return this.pipeline.preferPatchStyleMutationCalls(toolCalls, allToolSpecs);",
    "private enforceBuildFixPostBuildProgression(": "return this.pipeline.enforceBuildFixPostBuildProgression(toolCalls, allToolSpecs);",
    "private extractBlankWorkspacePath(": "return this.pipeline.extractBlankWorkspacePath(text);",
    "private extractHtmlMarker(": "return this.pipeline.extractHtmlMarker(text);",
    "private buildPostMutationVerificationToolCalls(": "return this.pipeline.buildPostMutationVerificationToolCalls(allToolSpecs);",
    "private getBlockedToolCallReason(": "return this.pipeline.getBlockedToolCallReason(toolCall);",
    "private buildPlainTextFallbackForBlockedToolCall(": "return this.pipeline.buildPlainTextFallbackForBlockedToolCall(toolCall);",
    "private isProtectedManifestPath(": "return this.pipeline.isProtectedManifestPath(filePath);",
    "private patchTouchesProtectedManifest(": "return this.pipeline.patchTouchesProtectedManifest(patchText);",
    "private normalizeToolInput(": "return this.pipeline.normalizeToolInputInternal(toolName, input);",
    "private sanitizeSearchQuery(": "return this.pipeline.sanitizeSearchQuery(value, maxChars);",
    "private coerceString(": "return coerceString(value);",
    "private coerceBoolean(": "return coerceBoolean(value, fallback);",
    "private coerceNumber(": "return coerceNumber(value, fallback);",
    "private coerceInteger(": "return coerceInteger(value, fallback);",
    "private clampReadFileRange(": "return this.pipeline.clampReadFileRange(filePath, startLine, endLine);",
    "private tryGetFileLineCount(": "return this.pipeline.tryGetFileLineCount(filePath);",
    "private isReadOnlyTool(": "return this.pipeline.isReadOnlyTool(toolName);",
    "private isReadRangeAlreadyCovered(": "return this.pipeline.isReadRangeAlreadyCovered(filePath, startLine, endLine);",
    "private recordReadRangeCoverage(": "this.pipeline.recordReadRangeCoverage(filePath, startLine, endLine);",
    "private stableSerialize(": "return stableSerialize(value);",
    "private cleanAssistantDisplayText(": "return this.pipeline.cleanAssistantDisplayText(content);",
    "private shortenPathForStatus(": "return this.pipeline.shortenPathForStatus(filePath);",
    "private formatToolProgressLine(": "return this.pipeline.formatToolProgressLine(toolCall);",
    "private reportToolBatchProgress(": "this.pipeline.reportToolBatchProgress(progress, toolCalls);",
    "private emitStatusLine(": "this.pipeline.emitStatusLine(progress, line);",
    "private isMutatingTool(": "return this.pipeline.isMutatingTool(toolName);",
    "private isVerificationTool(": "return this.pipeline.isVerificationTool(toolName, toolInput);",
    "private isExploratoryContextTool(": "return this.pipeline.isExploratoryContextTool(toolName);",
    "private shouldSuppressDuplicateToolCall(": "return this.pipeline.shouldSuppressDuplicateToolCall(toolName, toolInput);",
    "private noteEmittedToolCall(": "this.pipeline.noteEmittedToolCall(toolName, toolInput);",
    "private getActiveReplacementIntent(": "return this.pipeline.getActiveReplacementIntent();",
    "private isProtectedDeleteCommand(": "return this.pipeline.isProtectedDeleteCommand(command);",
    "private isCopyMoveCommandForReplacementIntent(": "return this.pipeline.isCopyMoveCommandForReplacementIntent(command);",
    "private isLikelyThirdPartyBuildErrorPath(": "return this.pipeline.isLikelyThirdPartyBuildErrorPath(filePath);",
    "private nextCallId(": "return nextCallId();",

    # ToolLookupGate delegations
    "private async selectToolsViaLookupGate(": "return this.toolLookupGate.selectToolsViaLookupGate(requestBase, availableTools, abortController);",
    "private updatePersistedLookupWindowAfterTurn(": "this.toolLookupGate.updatePersistedLookupWindowAfterTurn(usedToolNames);",
    "private rankToolsForLookup(": "return this.toolLookupGate.rankToolsForLookup(query, tools);",
    "private scoreToolsForLookup(": "return this.toolLookupGate.scoreToolsForLookup(query, tools);",
    "private selectModelLookupBypassTools(": "return this.toolLookupGate.selectModelLookupBypassTools(query, tools, maxResults);",
    "private expandLookupTokens(": "return this.toolLookupGate.expandLookupTokens(tokens);",
    "private createLookupToolSpec(": "return this.toolLookupGate['createLookupToolSpec']();",
    "private getToolLookupMaxResults(": "return this.toolLookupGate.getToolLookupMaxResults(availableToolsCount);",
    "private getToolLookupTimeoutMs(": "return this.toolLookupGate.getToolLookupTimeoutMs();",
    "private getToolLookupMode(": "return this.toolLookupGate.getToolLookupMode();",
    "private getToolSelectionStrategy(": "return this.toolLookupGate.getToolSelectionStrategy();",
    "private buildLookupRequestKey(": "return buildLookupRequestKey(latestUserText);",
    "private resolveToolsByName(": "return resolveToolsByNameUtil(availableTools, toolNames);",
    "private mergeToolsByName(": "return mergeToolsByNameUtil(preferredTools, secondaryTools);",

    # ToolSelectionHelpers delegations
    "private prioritizeToolsForIntent(": "return this.toolSelectionHelpers.prioritizeToolsForIntent(tools, messages);",
    "private selectInitialToolSubset(": "return this.toolSelectionHelpers.selectInitialToolSubset(tools, messages, performanceProfile);",
    "private ensureIntentRequiredTools(": "return this.toolSelectionHelpers.ensureIntentRequiredTools(selectedTools, availableTools, lockedIntent, this.isDeterministicComplianceHarnessMode());",
    "private shouldPreferToolCallsForText(": "return this.toolSelectionHelpers.shouldPreferToolCallsForText(text);",
    "private shouldPreferToolCalls(": "return this.toolSelectionHelpers.shouldPreferToolCallsForText(this.getLatestUserMessageText(messages));",
    "private getLatestUserMessageText(": "return getLatestUserMessageTextUtil(messages);",
    "private getLatestLookupQueryText(": "return getLatestLookupQueryTextUtil(messages);",
    "private getPrimaryLookupTaskText(": "return getPrimaryLookupTaskTextUtil(messages);",

    # MessageConverter delegations
    "private convertRequestMessage(": "return this.messageConverter.convertRequestMessage(message, compactEnvelopeMessages);",
    "private partToText(": "return this.messageConverter.partToText(part);",
    "private extractImageBase64(": "return this.messageConverter.extractImageBase64(part);",
    "private toBase64(": "return this.messageConverter.toBase64(payload);",
    "private looksLikeCopilotPreamble(": "return this.messageConverter.looksLikeCopilotPreamble(content);",
    "private compactEnvelopeUserMessage(": "return this.messageConverter.compactEnvelopeUserMessage(content);",
    "private minimizeCopilotPreamble(": "return this.messageConverter.minimizeCopilotPreamble(content);",
    "private compactCopilotPreambleContent(": "return this.messageConverter.compactCopilotPreambleContent(content);",
    "private extractTaggedSection(": "return this.messageConverter.extractTaggedSection(content, tag);",
    "private sanitizeCopilotPreambleMessage(": "return this.messageConverter.sanitizeCopilotPreambleMessage(content, stripRefusal, stripStyle, compact);",
    "private isDebugDumpEnabled(": "return this.messageConverter.isDebugDumpEnabled();",
    "private writeDebugDump(": "this.messageConverter.writeDebugDump(filePath, payload, summary);",
    "private truncateMiddle(": "return truncateMiddleUtil(content, maxChars);",
    "private mapMessageRole(": "return this.messageConverter.mapMessageRole(role);",

    # MessageCompactor delegations
    "private estimateMessageSize(": "return this.messageCompactor.estimateMessageSize(message);",
    "private optimizeMessagesForLatency(": "return this.messageCompactor.optimizeMessagesForLatency(messages, performanceProfile);",
    "private shouldCompactContinuationMessages(": "return this.messageCompactor.shouldCompactContinuationMessages(messages, contextWindowTokens);",
    "private compactContinuationMessages(": "return this.messageCompactor.compactContinuationMessages(messages);",
    "private async summarizeConversationForContinuation(": "return this.messageCompactor.summarizeConversationForContinuation(endpoint, model, temperature, contextWindowTokens, messages, lockedIntent, abortController);",
    "private findLatestUserIndex(": "return this.messageCompactor.findLatestUserIndex(messages);",
    "private findLatestMeaningfulUserIndex(": "return this.messageCompactor.findLatestMeaningfulUserIndex(messages);",
    "private findLatestAssistantToolCallIndex(": "return this.messageCompactor.findLatestAssistantToolCallIndex(messages);",
    "private findFirstUserIndex(": "return this.messageCompactor.findFirstUserIndex(messages);",
    "private extractLookupIntentText(": "return extractLookupIntentTextUtil(content);",

    # ModelRegistry delegations
    "private async fetchModelInfos(": "return this.modelRegistry.fetchModelInfosInternal(endpoint, fallbackModel);",
    "private async hydrateMissingContextLengths(": "return this.modelRegistry.hydrateMissingContextLengths(models, endpoint, abortSignal, timeoutMs);",
    "private getCachedModelInfos(": "return this.modelRegistry.getCachedModelInfos();",
    "private getAdvertisedTokenCaps(": "return this.modelRegistry.getAdvertisedTokenCaps(modelDetails);",
    "private extractModelContextLength(": "return this.modelRegistry.extractModelContextLength(modelDetails);",
    "private inferFamily(": "return this.modelRegistry.inferFamily(modelName);",
    "private createFallbackInfo(": "return this.modelRegistry.createFallbackInfo(model);",

    # BuildFix passthrough wrappers
    "private isBuildFixIntent(": "return isBuildFixIntentText(text);",
    "private isExploratoryTerminalCommand(": "return isExploratoryTerminalCommandText(command);",
    "private isBuildOrVerifyTerminalCommand(": "return isBuildOrVerifyTerminalCommandText(command);",
    "private inferBuildFixTerminalCommand(": "return inferBuildFixTerminalCommandText(intentText);",

    # Intent text passthrough wrappers
    "private looksLikeToolInputError(": "return looksLikeToolInputErrorText(text);",
    "private looksLikeInstructionalPreamble(": "return looksLikeInstructionalPreambleText(text);",
    "private looksLikeEnvelopeContext(": "return looksLikeEnvelopeContextText(content);",
    "private looksLikeOperationalLookupNoise(": "return looksLikeOperationalLookupNoiseText(text);",
    "private looksLikeDirectoryListing(": "return looksLikeDirectoryListingText(text);",
    "private sanitizeIntentCandidate(": "return sanitizeIntentCandidateText(text);",
    "private normalizePublicAssetPathErrorIntent(": "return normalizePublicAssetPathErrorIntentText(text);",
    "private extractGlobalReplacementIntent(": "return extractGlobalReplacementIntentText(text);",

    # ToolSpecBuilder delegations
    "private buildToolSpecCacheKey(": "// no longer needed",
    "private countSchemaProperties(": "// no longer needed",
    "private compactToolDescription(": "// no longer needed",
    "private compactJsonSchema(": "// no longer needed",
}


def find_method_body(content, method_prefix):
    """Find the start and end of a method body given a prefix that uniquely identifies it."""
    # Look for lines that start with this prefix (with optional leading whitespace)
    pattern = r'\n(\s+)' + re.escape(method_prefix.lstrip())
    match = re.search(pattern, content)
    if not match:
        return None, None

    start_pos = match.start()

    # Find the opening brace
    brace_pos = content.find('{', match.end())
    if brace_pos == -1:
        return None, None

    # Count braces to find the matching close brace
    depth = 1
    pos = brace_pos + 1
    while pos < len(content) and depth > 0:
        ch = content[pos]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        pos += 1

    if depth != 0:
        return None, None

    return start_pos, pos


def replace_method_body(content, method_prefix, new_body):
    """Replace a method body with a delegation stub."""
    # Find the method signature line
    pattern = r'(\n\s+' + re.escape(method_prefix.lstrip()) + r'[^\{]*\{)[^\}]*?(\n\s+\})'

    # Find the method start
    search_pattern = r'\n(\s+)' + re.escape(method_prefix.lstrip())
    match = re.search(search_pattern, content)
    if not match:
        return content, False

    indent = match.group(1)
    method_name_start = match.start()

    # Find signature end (the opening brace)
    brace_pos = content.find('{', match.end())
    if brace_pos == -1:
        return content, False

    signature = content[method_name_start:brace_pos + 1]

    # Count braces to find end
    depth = 1
    pos = brace_pos + 1
    while pos < len(content) and depth > 0:
        ch = content[pos]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        pos += 1

    if depth != 0:
        return content, False

    method_end = pos

    # Build the replacement
    if new_body.startswith("//"):
        # Delete the method entirely (unused helpers)
        replacement = ""
    else:
        replacement = signature + f"\n{indent}  {new_body}\n{indent}}}"

    new_content = content[:method_name_start] + replacement + content[method_end:]
    return new_content, True


with open(FILE, "r") as f:
    content = f.read()

original_lines = content.count('\n')
replaced_count = 0
skipped = []

for prefix, stub in DELEGATIONS.items():
    new_content, did_replace = replace_method_body(content, prefix, stub)
    if did_replace:
        content = new_content
        replaced_count += 1
    else:
        skipped.append(prefix)

new_lines = content.count('\n')

with open(FILE, "w") as f:
    f.write(content)

print(f"Replaced {replaced_count}/{len(DELEGATIONS)} methods")
print(f"Lines: {original_lines} → {new_lines} (reduced by {original_lines - new_lines})")
if skipped:
    print(f"\nSkipped (not found):")
    for s in skipped:
        print(f"  - {s}")
