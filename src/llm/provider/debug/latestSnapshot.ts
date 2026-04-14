import * as vscode from "vscode";
import { writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

export type LatestDebugSnapshotSource = "participant" | "autonomous" | "lm-provider" | "tools";

export interface LatestDebugSnapshot {
  generatedAt: string;
  source: LatestDebugSnapshotSource;
  platform: string;
  data: unknown;
}

function getWorkspaceRoot(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root?.trim() ? root : undefined;
}

function resolveWorkspacePath(relOrAbs: string): string | undefined {
  const trimmed = relOrAbs.trim();
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) return trimmed;
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  return path.join(root, trimmed);
}

export function isLatestDebugSnapshotEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("localQwen")
    .get<boolean>("latestDebugSnapshotEnabled", true);
}

export function getLatestDebugSnapshotPath(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("localQwen")
    .get<string>("latestDebugSnapshotFile", ".local-qwen/latest-debug-snapshot.json");
  return resolveWorkspacePath(configured);
}

function safeTruncateJson(value: unknown, maxChars: number): unknown {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxChars) return value;
    return {
      truncated: true,
      maxChars,
      preview: raw.slice(0, maxChars),
    };
  } catch {
    return { truncated: true, maxChars, preview: String(value).slice(0, maxChars) };
  }
}

/**
 * Best-effort writer for a single, overwrite-in-place snapshot.
 * Intended for humans + the agent to inspect the latest run without stale log buildup.
 */
export async function writeLatestDebugSnapshot(params: {
  output?: { appendLine: (line: string) => void };
  source: LatestDebugSnapshotSource;
  data: unknown;
}): Promise<void> {
  if (!isLatestDebugSnapshotEnabled()) return;

  const filePath = getLatestDebugSnapshotPath();
  if (!filePath) return;

  const snapshot: LatestDebugSnapshot = {
    generatedAt: new Date().toISOString(),
    source: params.source,
    platform: process.platform,
    // Keep this compact to avoid accidentally dumping huge payloads.
    data: safeTruncateJson(params.data, 120000),
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {
    params.output?.appendLine?.("[local-qwen] latest debug snapshot write failed (ignored)");
  }
}
