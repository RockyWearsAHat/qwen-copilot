import * as vscode from "vscode";
import { appendFile, mkdir, writeFile } from "fs/promises";
import * as path from "path";

export interface OutboundOllamaLogEntry {
  timestamp: string;
  source: "lm-provider" | "participant";
  request: unknown;
}

function getWorkspaceRoot(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root?.trim() ? root : undefined;
}

function resolveLogPath(configuredPath: string): string | undefined {
  const trimmed = configuredPath.trim();
  if (!trimmed) {
    return undefined;
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }

  return path.join(root, trimmed);
}

export function isOutboundLoggingEnabled(): boolean {
  return vscode.workspace.getConfiguration("localQwen").get<boolean>("outboundLogEnabled", false);
}

export function getOutboundLogFilePath(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("localQwen")
    .get<string>("outboundLogFile", ".local-qwen/outbound.jsonl");
  return resolveLogPath(configured);
}

function getOutboundLatestFilePath(): string | undefined {
  const jsonl = getOutboundLogFilePath();
  if (!jsonl) return undefined;
  const dir = path.dirname(jsonl);
  const base = path.basename(jsonl);

  // local-qwen-ollama-outbound.jsonl -> local-qwen-ollama-outbound.latest.json
  const latestName = base.endsWith(".jsonl")
    ? base.replace(/\.jsonl$/i, ".latest.json")
    : `${base}.latest.json`;
  return path.join(dir, latestName);
}

export async function appendOutboundOllamaRequestLog(params: {
  output: { appendLine: (line: string) => void };
  source: OutboundOllamaLogEntry["source"];
  request: unknown;
}): Promise<void> {
  if (!isOutboundLoggingEnabled()) {
    return;
  }

  const filePath = getOutboundLogFilePath();
  if (!filePath) {
    return;
  }

  const entry: OutboundOllamaLogEntry = {
    timestamp: new Date().toISOString(),
    source: params.source,
    request: params.request,
  };

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");

    const latestPath = getOutboundLatestFilePath();
    if (latestPath) {
      await mkdir(path.dirname(latestPath), { recursive: true });
      await writeFile(latestPath, JSON.stringify(entry, null, 2), "utf8");
    }
  } catch {
    // best-effort only
    params.output.appendLine("[local-qwen] outbound log write failed (ignored)");
  }
}
