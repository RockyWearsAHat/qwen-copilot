import * as vscode from "vscode";
import { readFile, readdir } from "node:fs/promises";
import * as nodePath from "node:path";
import { existsSync } from "node:fs";

/** Directories to always skip when building the workspace file tree. */
const TREE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  ".vscode",
  ".cache",
  ".local-qwen",
  "coverage",
  ".coverage",
  "__pycache__",
  ".next",
  ".nuxt",
  "out",
]);

/** Files to always skip when building the workspace file tree (debug logs, etc.). */
const TREE_SKIP_FILES = new Set([
  "local-qwen-ollama-outbound.json",
  "local-qwen-ollama-outbound.jsonl",
]);

/** Returns true if a filename is a debug/log file that should be excluded from the tree & grep. */
export function isDebugLogFile(name: string): boolean {
  if (TREE_SKIP_FILES.has(name)) return true;
  // Catch .latest.json and similar derived log files
  if (name.startsWith("local-qwen-ollama-outbound")) return true;
  return false;
}

/**
 * Builds an indented file tree string for the workspace, e.g.:
 *   src/
 *     game.ts
 *     platformerGame.ts
 *   assets/             ← Vite publicDir: served at web root "/"
 *     PNG/              ← served at "/PNG/"
 *       sprite.png
 *
 * Caps output to avoid bloating the context window.
 */
async function buildFileTree(
  workspaceRoot: string,
  vitePublicDir: string | null,
  maxFiles = 400,
): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string, indent: string): Promise<void> {
    if (count >= maxFiles) return;
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    // Dirs first, then files, both sorted
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter((e) => !e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of [...dirs, ...files]) {
      if (count >= maxFiles) {
        lines.push(`${indent}… (truncated)`);
        return;
      }
      if (entry.isDirectory()) {
        if (TREE_SKIP_DIRS.has(entry.name)) continue;
        const relFromRoot = nodePath
          .relative(workspaceRoot, nodePath.join(dir, entry.name))
          .replace(/\\/g, "/");
        let annotation = "";
        if (vitePublicDir && relFromRoot === vitePublicDir) {
          annotation = `  ← Vite publicDir: served at web root "/"`;
        } else if (vitePublicDir) {
          const pubRel = nodePath
            .relative(nodePath.join(workspaceRoot, vitePublicDir), nodePath.join(dir, entry.name))
            .replace(/\\/g, "/");
          if (!pubRel.startsWith("..")) {
            annotation = `  ← served at "/${pubRel}/"`;
          }
        }
        lines.push(`${indent}${entry.name}/${annotation}`);
        count++;
        await walk(nodePath.join(dir, entry.name), indent + "  ");
      } else {
        if (isDebugLogFile(entry.name)) continue;
        lines.push(`${indent}${entry.name}`);
        count++;
      }
    }
  }

  await walk(workspaceRoot, "");
  return lines.join("\n");
}

/**
 * Reads the workspace's Vite config (if present) and returns the configured
 * publicDir value, or null if this is not a Vite project.
 */
async function detectVitePublicDir(workspaceRoot: string): Promise<string | null> {
  for (const cfg of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
    try {
      const src = await readFile(nodePath.join(workspaceRoot, cfg), "utf8");
      const m = src.match(/publicDir\s*:\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
      // Vite present but no explicit publicDir — check which candidate dir exists
      for (const candidate of ["public", "assets", "static"]) {
        if (existsSync(nodePath.join(workspaceRoot, candidate))) return candidate;
      }
      return "public";
    } catch {
      // config file absent — try next
    }
  }
  return null;
}

/** Builds the completion checklist system message payload. */
export async function buildCompletionChecklistSnapshot(): Promise<string> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return "";
    }

    const relPath = ".github/completion-checklist.md";
    const absPath = nodePath.join(workspaceRoot, relPath);

    let raw = "";
    try {
      raw = await readFile(absPath, "utf8");
    } catch {
      // File doesn't exist — return empty so we don't inject noise into real requests.
      return "";
    }

    const normalized = raw.replace(/\r\n/g, "\n").trim();
    const maxChars = 12000;
    const clipped =
      normalized.length > maxChars
        ? `${normalized.slice(0, maxChars).trimEnd()}\n\n...\n\n(Truncated to ${maxChars} chars)`
        : normalized;

    if (!clipped) {
      return "";
    }

    return [
      "## Completion Checklist (auto-injected — hard gate)",
      `**source:** ${relPath}`,
      "**rule:** Do NOT claim completion until every checklist item is satisfied (or explicitly justified as not applicable).",
      "",
      clipped,
    ].join("\n");
  } catch {
    return "";
  }
}

/** Builds a compact workspace context snapshot to prepend to every LLM request. */
export async function buildWorkspaceContextSnapshot(): Promise<string> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return "";
    }

    const snapshotTimestamp = new Date().toISOString();
    const lines: string[] = [
      "## Workspace Context — LIVE SNAPSHOT (auto-injected, rebuilt each request)",
      `**Generated at:** ${snapshotTimestamp}`,
      `**Workspace root on disk:** \`${workspaceRoot}\``,
      `**All tool calls that take a file path require an absolute path. Prepend the workspace root above to any relative path in this snapshot.**`,
      `  Example: to read \`src/game.ts\`, use path \`${workspaceRoot}/src/game.ts\``,
      "",
      `**How this snapshot was built:** The extension recursively walked every directory under \`${workspaceRoot}\` (equivalent to \`find ${workspaceRoot} -type f\` or calling list_dir on every folder). The result is the complete file tree below.`,
      "**This snapshot supersedes the <workspace_info> block above**, which may be truncated and only shows directories. The tree below shows every file.",
      "For a broken import or asset reference: check the file tree below — do not call find, ls, or list_dir to rediscover what is already listed here.",
    ];

    // --- package.json -------------------------------------------------------
    try {
      const pkgRaw = await readFile(nodePath.join(workspaceRoot, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const allDeps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };
      const toolchainKeys = Object.keys(allDeps).filter((k) =>
        /vite|webpack|rollup|parcel|esbuild|tsc\b|tsx\b|turbo/i.test(k),
      );
      const scriptNames = Object.keys((pkg.scripts as Record<string, string>) ?? {});
      lines.push(
        `**project:** ${String(pkg.name ?? "unknown")}` +
          (toolchainKeys.length ? ` | **build tools:** ${toolchainKeys.join(", ")}` : "") +
          (scriptNames.length ? ` | **scripts:** ${scriptNames.join(", ")}` : ""),
      );
    } catch {
      // package.json absent or malformed — skip
    }

    // --- Config files -------------------------------------------------------
    const configCandidates = [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.mjs",
      "webpack.config.js",
      "webpack.config.ts",
      "tsconfig.json",
      "tsconfig.app.json",
    ];
    const foundConfigs: string[] = [];
    for (const cf of configCandidates) {
      try {
        await readFile(nodePath.join(workspaceRoot, cf), "utf8");
        foundConfigs.push(cf);
      } catch {
        // absent
      }
    }
    if (foundConfigs.length) {
      lines.push(`**config files:** ${foundConfigs.join(", ")}`);
    }

    // --- Vite config (raw content) + publicDir semantics --------------------
    const vitePublicDir = await detectVitePublicDir(workspaceRoot);
    for (const cfg of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
      try {
        const cfgContent = await readFile(nodePath.join(workspaceRoot, cfg), "utf8");
        lines.push(`**${cfg}:**\n\`\`\`\n${cfgContent.trim()}\n\`\`\``);
        break;
      } catch {
        /* absent */
      }
    }
    if (vitePublicDir) {
      lines.push(
        `**Vite publicDir = "${vitePublicDir}"** — PATH RULE (critical):`,
        `  • The \`${vitePublicDir}/\` folder on disk is the browser's web root \`/\`.`,
        `  • Strip "${vitePublicDir}/" from any disk path to get the URL path used in code.`,
        `  • Example: disk \`${vitePublicDir}/images/hero.png\` → code \`"/images/hero.png"\``,
        `  • ✅ CORRECT in code: \`"/images/hero.png"\``,
        `  • ❌ WRONG in code:  \`"${vitePublicDir}/images/hero.png"\` — do NOT include "${vitePublicDir}/" as a prefix in any path string written in source files.`,
      );
    }

    // --- Open editor file contents ------------------------------------------
    // Inject the content of currently visible editors upfront so the model
    // never needs a read_file tool call for files the user already has open.
    // This mirrors what the real Copilot agent does automatically.
    const maxOpenFileChars = 12000;
    const maxOpenFiles = 6;
    const injectedPaths = new Set<string>();
    const openEditorLines: string[] = [];

    const collectEditor = (editor: vscode.TextEditor) => {
      if (openEditorLines.length >= maxOpenFiles) return;
      const uri = editor.document.uri;
      if (uri.scheme !== "file") return;
      const absPath = uri.fsPath;
      if (injectedPaths.has(absPath)) return;
      const relPath = nodePath.relative(workspaceRoot, absPath).replace(/\\/g, "/");
      if (relPath.startsWith("..")) return; // outside workspace
      injectedPaths.add(absPath);
      const fullText = editor.document.getText();
      const truncated =
        fullText.length > maxOpenFileChars
          ? fullText.slice(0, maxOpenFileChars) + `\n… (truncated at ${maxOpenFileChars} chars)`
          : fullText;
      openEditorLines.push(
        `**Currently open file: \`${relPath}\`** — ⚠️ FULL CONTENT BELOW. Do NOT call read_file for this file. For error reports: find the property, read its VALUE, compare to the error path.\n\`\`\`\n${truncated}\n\`\`\``,
      );
    };

    // Active editor first (most relevant), then other visible editors
    const active = vscode.window.activeTextEditor;
    if (active) collectEditor(active);
    for (const editor of vscode.window.visibleTextEditors) {
      if (openEditorLines.length >= maxOpenFiles) break;
      collectEditor(editor);
    }

    if (openEditorLines.length > 0) {
      lines.push(
        "## Open Editor Contents (pre-loaded — do NOT call read_file for these files)",
        "⚠️ **STALE ERROR CHECK — READ CAREFULLY:** If there is an error about a path/URL, find the relevant property in the code below. " +
          "Read the VALUE (the string after the colon, NOT the property name). " +
          'Example: `explosion: "/PNG/grenade.png"` — the VALUE is `/PNG/grenade.png`, NOT `/PNG/explosion.png`. ' +
          "The property NAME may match the error, but if the VALUE differs → **the error is stale** → respond immediately, zero tool calls.",
        ...openEditorLines,
      );
    }

    // --- Full workspace file tree -------------------------------------------
    // Annotated with Vite publicDir serving paths inline so the model knows
    // exactly where each file lives and what URL path it maps to.
    const tree = await buildFileTree(workspaceRoot, vitePublicDir);
    if (tree) {
      lines.push(
        `**Complete workspace file tree** (this IS list_dir on every folder — do NOT call list_dir, it returns this same data):\n\`\`\`\n${tree}\n\`\`\``,
        `⚠️ Do NOT call list_dir or find — the file tree above is complete. If a file is not listed, it does not exist.`,
      );
    }

    return lines.length > 1 ? lines.join("\n") : "";
  } catch {
    return "";
  }
}
