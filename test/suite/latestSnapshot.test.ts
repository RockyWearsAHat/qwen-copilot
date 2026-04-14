import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { writeLatestDebugSnapshot } from "../../src/llm/provider/debug/latestSnapshot";

suite("Latest debug snapshot", () => {
  test("writes a single overwrite-in-place snapshot file", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-qwen-snapshot-"));
    const snapshotRel = ".local-qwen/latest-debug-snapshot.json";
    const snapshotPath = path.join(tmpRoot, snapshotRel);

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalGetConfiguration = vscode.workspace.getConfiguration;

    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [{ uri: vscode.Uri.file(tmpRoot) }],
    });

    Object.defineProperty(vscode.workspace, "getConfiguration", {
      configurable: true,
      value: () => ({
        get: (key: string, fallback: unknown) => {
          if (key === "latestDebugSnapshotEnabled") return true;
          if (key === "latestDebugSnapshotFile") return snapshotRel;
          return fallback;
        },
      }),
    });

    try {
      await writeLatestDebugSnapshot({ source: "participant", data: { n: 1 } });
      const first = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as any;
      assert.equal(first.source, "participant");
      assert.equal(first.data.n, 1);

      await writeLatestDebugSnapshot({ source: "participant", data: { n: 2 } });
      const second = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as any;
      assert.equal(second.data.n, 2);
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        value: originalWorkspaceFolders,
      });
      Object.defineProperty(vscode.workspace, "getConfiguration", {
        configurable: true,
        value: originalGetConfiguration,
      });
    }
  });
});
