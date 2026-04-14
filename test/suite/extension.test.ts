import assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Local Qwen Extension Host", () => {
  test("contributes expected commands", async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes("localQwen.refreshTools"));
    assert.ok(commands.includes("localQwen.runSmokeTest"));
    assert.ok(commands.includes("localQwen.listLocalModels"));
    assert.ok(commands.includes("localQwen.verifyModelProvider"));
  });

  test("refreshTools command executes", async () => {
    await vscode.commands.executeCommand("localQwen.refreshTools");
  });
});
