#!/usr/bin/env python3
import re

with open("src/llm/localLanguageModelProvider.ts", "r") as f:
    content = f.read()

state_fields = [
    "mutationCounterForTurn",
    "buildFixBuildExecutedForTurn",
    "buildFixForcedDiagnosisForTurn",
    "buildFixExplorationSinceBuild",
    "buildFixPreBuildExplorationCount",
    "buildFixEscalatedReadEnd",
    "buildFixCandidateErrorFileForTurn",
    "verificationCheckpointForTurn",
    "terminalCommandMutationCheckpoint",
    "emittedReadOnlyToolFingerprintsForTurn",
    "readFileCoverageForTurn",
    "currentLockedIntentForTurn",
    "allowDestructiveTerminalDeletesForTurn",
    "allowPackageManifestEditsForTurn",
    "guardrailAutoToolKickoffUsedForTurn",
    "lastProgressStatusLine",
    "activeDedupeRequestKey",
    "persistedRequestScopeKey",
    "persistedUserGoalForRequest",
    "persistedReplacementIntent",
    "consecutiveToolOnlyTurns",
    "fileLineCountCache",
    "lastLookupSelection",
    "persistedLookupWindow",
    "lookupBackoffKey",
    "lookupBackoffUntil",
]

for field in state_fields:
    # Replace this.fieldName with this.state.fieldName
    # but NOT if it already is this.state.fieldName
    content = re.sub(
        r'\bthis\.(?!state\.)(' + re.escape(field) + r')\b',
        r'this.state.\1',
        content
    )

with open("src/llm/localLanguageModelProvider.ts", "w") as f:
    f.write(content)

print("Done. State field redirections applied.")
