import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

interface BackgroundProcess {
  process: cp.ChildProcess;
  output: string;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();

function getWorkspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error("No workspace is currently open.");
  }
  return root;
}

function isAllowedPath(targetPath: string): boolean {
  const allowOutsideWorkspace = vscode.workspace
    .getConfiguration("localQwen")
    .get<boolean>("allowOutsideWorkspaceFileOps", false);

  if (allowOutsideWorkspace) {
    return true;
  }

  const workspaceRoot = getWorkspaceRoot();
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedTarget = path.resolve(targetPath);

  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

async function readUtf8(filePath: string): Promise<string> {
  if (!isAllowedPath(filePath)) {
    throw new Error(
      "Path is outside workspace and allowOutsideWorkspaceFileOps is disabled.",
    );
  }
  return fs.readFile(filePath, "utf8");
}

function normalizeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePattern(input: string, isRegexp: boolean): RegExp {
  if (!isRegexp) {
    const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i");
  }

  return new RegExp(input, "i");
}

export async function tool_read_file(
  args: Record<string, unknown>,
): Promise<unknown> {
  const filePath = String(args.filePath ?? "");
  if (!filePath) {
    throw new Error("filePath is required.");
  }

  const startLine = Math.max(1, normalizeNumber(args.startLine, 1));
  const endLine = Math.max(
    startLine,
    normalizeNumber(args.endLine, startLine + 200),
  );

  const content = await readUtf8(filePath);
  const lines = content.split(/\r?\n/);
  const selected = lines.slice(startLine - 1, endLine);

  return {
    filePath,
    startLine,
    endLine,
    content: selected.join("\n"),
  };
}

export async function tool_list_dir(
  args: Record<string, unknown>,
): Promise<unknown> {
  const targetPath = String(args.path ?? getWorkspaceRoot());
  if (!isAllowedPath(targetPath)) {
    throw new Error(
      "Path is outside workspace and allowOutsideWorkspaceFileOps is disabled.",
    );
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  return entries.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : entry.name,
  );
}

export async function tool_file_search(
  args: Record<string, unknown>,
): Promise<unknown> {
  const query = String(args.query ?? "**/*");
  const maxResults = normalizeNumber(args.maxResults, 100);

  const files = await vscode.workspace.findFiles(
    query,
    "**/node_modules/**",
    maxResults,
  );
  return files.map((uri) => uri.fsPath);
}

export async function tool_grep_search(
  args: Record<string, unknown>,
): Promise<unknown> {
  const query = String(args.query ?? "");
  const isRegexp = Boolean(args.isRegexp ?? false);
  const includePattern = args.includePattern
    ? String(args.includePattern)
    : "**/*";
  const maxResults = normalizeNumber(args.maxResults, 200);

  if (!query) {
    throw new Error("query is required.");
  }

  const regex = parsePattern(query, isRegexp);
  const files = await vscode.workspace.findFiles(
    includePattern,
    "**/node_modules/**",
    maxResults,
  );
  const results: Array<{ file: string; line: number; text: string }> = [];

  for (const fileUri of files) {
    if (results.length >= maxResults) {
      break;
    }

    let content = "";
    try {
      content = await fs.readFile(fileUri.fsPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (
      let index = 0;
      index < lines.length && results.length < maxResults;
      index += 1
    ) {
      const text = lines[index];
      if (regex.test(text)) {
        results.push({
          file: fileUri.fsPath,
          line: index + 1,
          text,
        });
      }
    }
  }

  return results;
}

export async function tool_run_in_terminal(
  args: Record<string, unknown>,
): Promise<unknown> {
  const command = String(args.command ?? "").trim();
  const explanation = String(args.explanation ?? "");
  const goal = String(args.goal ?? "");
  const isBackground = Boolean(args.isBackground ?? false);
  const timeout = normalizeNumber(args.timeout, 0);

  if (!command) {
    throw new Error("command is required.");
  }

  if (!isBackground) {
    return new Promise((resolve, reject) => {
      cp.exec(
        command,
        {
          cwd: getWorkspaceRoot(),
          timeout: timeout > 0 ? timeout : undefined,
          shell: "/bin/zsh",
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              explanation,
              goal,
              command,
              exitCode: error.code ?? 1,
              stdout,
              stderr: stderr || error.message,
            });
            return;
          }

          resolve({
            explanation,
            goal,
            command,
            exitCode: 0,
            stdout,
            stderr,
          });
        },
      );
    });
  }

  const child = cp.spawn("/bin/zsh", ["-lc", command], {
    cwd: getWorkspaceRoot(),
    detached: false,
  });

  const id = nextId();
  const state: BackgroundProcess = {
    process: child,
    output: "",
  };
  backgroundProcesses.set(id, state);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    state.output += chunk.toString();
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    state.output += chunk.toString();
  });

  child.on("exit", (code, signal) => {
    state.output += `\n[process exited code=${code ?? "null"} signal=${signal ?? "null"}]`;
  });

  return {
    id,
    pid: child.pid,
    status: "running",
  };
}

export async function tool_get_terminal_output(
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = String(args.id ?? "");
  if (!id) {
    throw new Error("id is required.");
  }

  const processState = backgroundProcesses.get(id);
  if (!processState) {
    throw new Error(`No background process found for id '${id}'.`);
  }

  return {
    id,
    output: processState.output,
  };
}

export async function tool_kill_terminal(
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = String(args.id ?? "");
  if (!id) {
    throw new Error("id is required.");
  }

  const processState = backgroundProcesses.get(id);
  if (!processState) {
    throw new Error(`No background process found for id '${id}'.`);
  }

  processState.process.kill("SIGTERM");
  backgroundProcesses.delete(id);
  return { id, status: "terminated" };
}
