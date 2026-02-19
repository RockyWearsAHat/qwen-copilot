#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { autopatchCopilotChat } from "./copilot-chat-autopatch.mjs";

function resolveRoots() {
  const env = process.env.COPILOT_EXTENSIONS_DIRS;
  if (env && env.trim()) {
    return env
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".cursor", "extensions"),
  ];
}

async function runPatchCycle() {
  try {
    const results = await autopatchCopilotChat();
    const touched = results.filter((result) => result.patched).length;
    if (touched > 0) {
      console.log(
        `[autopatch-watch] patched ${touched} installation(s). Reload VS Code windows to apply.`,
      );
    }
  } catch (error) {
    console.error("[autopatch-watch] patch cycle failed:", error);
  }
}

async function main() {
  await runPatchCycle();

  const roots = resolveRoots();
  const watchers = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    try {
      const watcher = fs.watch(
        root,
        { persistent: true },
        (_eventType, fileName) => {
          if (!fileName) {
            return;
          }

          const text = String(fileName);
          if (!text.startsWith("github.copilot-chat-")) {
            return;
          }

          setTimeout(() => {
            runPatchCycle();
          }, 1500);
        },
      );

      watchers.push(watcher);
      console.log(`[autopatch-watch] watching ${root}`);
    } catch (error) {
      console.error(`[autopatch-watch] failed to watch ${root}:`, error);
    }
  }

  if (watchers.length === 0) {
    console.error("[autopatch-watch] no extension roots found to watch.");
    process.exit(1);
  }

  process.on("SIGINT", () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    process.exit(0);
  });
}

main();
