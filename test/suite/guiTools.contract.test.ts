import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  tool_focus_window,
  tool_gui_click,
  tool_gui_key,
  tool_gui_type,
  tool_list_windows,
  tool_take_screenshot,
} from "../../src/tools/handlers";

suite("GUI tool contracts", () => {
  test("tool_focus_window validates required args", async () => {
    const result = (await tool_focus_window({})) as any;
    assert.equal(result.success, false);
    assert.ok(String(result.error).toLowerCase().includes("windowtitle is required"));
  });

  test("GUI tools fail fast with missing backends (PATH cleared)", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const typeRes = (await tool_gui_type({ text: "x" })) as any;
      assert.equal(typeRes.success, false);
      assert.ok(String(typeRes.error).includes("Type failed"));

      const keyRes = (await tool_gui_key({ key: "enter" })) as any;
      // tool_gui_key uses a generic failure message (no install hint) – just assert contract.
      assert.equal(keyRes.success, false);
      assert.ok(String(keyRes.error).includes("Key press failed"));

      const clickRes = (await tool_gui_click({ x: 10, y: 10 })) as any;
      assert.equal(clickRes.success, false);
      assert.ok(String(clickRes.error).includes("Click failed"));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("tool_take_screenshot returns structured failure when capture backend is unavailable", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const res = (await tool_take_screenshot({})) as any;
      assert.equal(res.success, false);
      assert.ok(String(res.error).includes("Screenshot failed"));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("tool_list_windows returns a stable object shape", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const res = (await tool_list_windows({})) as any;

      // On macOS without yabai: success true with empty list + note.
      // On Linux without wmctrl: success false with an error.
      // On Windows without powershell in PATH: success false.
      assert.ok(typeof res === "object" && res);
      assert.ok("success" in res);
      if (res.success === true) {
        assert.ok(Array.isArray(res.windows));
      } else {
        assert.ok(typeof res.error === "string");
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

suite("No osascript regression", () => {
  test("src/ contains no osascript invocation or references", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const srcRoot = path.join(repoRoot, "src");

    const files: string[] = [];
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
          files.push(full);
        }
      }
    };

    await walk(srcRoot);
    const offenders: Array<{ file: string; count: number }> = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      const matches = content.match(/\bosascript\b/gi);
      if (matches && matches.length > 0) {
        offenders.push({ file, count: matches.length });
      }
    }

    assert.deepEqual(offenders, []);
  });
});
