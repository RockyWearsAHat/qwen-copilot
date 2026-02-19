import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { extractToolNamesFromSource } from "./toolNameExtraction";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json"]);

export class ToolSourceParser {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public async discoverToolNames(): Promise<Set<string>> {
    const configuration = vscode.workspace.getConfiguration("localQwen");
    const roots = await this.getDiscoveryRoots(
      configuration.get<string[]>("toolDiscoveryRoots", []),
    );

    const maxFiles = configuration.get<number>("maxToolSourceFiles", 1500);
    const maxBytes = configuration.get<number>("maxToolSourceBytes", 300000);

    const discovered = new Set<string>();
    let scannedFiles = 0;

    for (const root of roots) {
      const files = await this.walk(root, maxFiles - scannedFiles);
      for (const filePath of files) {
        if (scannedFiles >= maxFiles) {
          break;
        }

        scannedFiles += 1;

        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          continue;
        }

        if (stat.size > maxBytes) {
          continue;
        }

        const content = await fs.readFile(filePath, "utf8");
        const names = extractToolNamesFromSource(content);
        for (const name of names) {
          discovered.add(name);
        }
      }

      if (scannedFiles >= maxFiles) {
        break;
      }
    }

    this.output.appendLine(
      `[local-qwen] Discovered ${discovered.size} tool names from ${scannedFiles} source files.`,
    );
    return discovered;
  }

  private async getDiscoveryRoots(extraRoots: string[]): Promise<string[]> {
    const roots = new Set<string>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.add(folder.uri.fsPath);
    }

    for (const root of extraRoots) {
      if (root && path.isAbsolute(root)) {
        roots.add(root);
      }
    }

    const copilotChat =
      vscode.extensions.getExtension("GitHub.copilot-chat") ??
      vscode.extensions.getExtension("github.copilot-chat");
    if (copilotChat?.extensionPath) {
      roots.add(copilotChat.extensionPath);
    }

    return [...roots];
  }

  private async walk(root: string, budget: number): Promise<string[]> {
    const results: string[] = [];
    if (budget <= 0) {
      return results;
    }

    const stack = [root];

    while (stack.length > 0 && results.length < budget) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (results.length >= budget) {
          break;
        }

        const fullPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".git")) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(extension)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
}
