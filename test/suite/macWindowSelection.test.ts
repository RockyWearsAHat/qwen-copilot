import assert from "node:assert/strict";

import { __selectBestMacWindowForTest } from "../../src/tools/handlers";

suite("macOS window selection", () => {
  test("prefers exact title match over partial", () => {
    const windows = [
      { id: 10, app: "Safari", title: "", layer: 0, alpha: 1 },
      { id: 11, app: "Code", title: "README.md — Visual Studio Code", layer: 0, alpha: 1 },
      { id: 12, app: "Code", title: "settings.json — Visual Studio Code", layer: 0, alpha: 1 },
      { id: 13, app: "Notes", title: "README.md", layer: 0, alpha: 1 },
    ];

    const best = __selectBestMacWindowForTest(windows as any, "README.md");
    assert.equal(best?.id, 13);
  });

  test("filters non-layer-0 windows", () => {
    const windows = [
      { id: 20, app: "Code", title: "Main", layer: 1, alpha: 1 },
      { id: 21, app: "Code", title: "Main", layer: 0, alpha: 1 },
    ];

    const best = __selectBestMacWindowForTest(windows as any, "Main");
    assert.equal(best?.id, 21);
  });

  test("returns undefined when no reasonable match", () => {
    const windows = [{ id: 30, app: "Safari", title: "Apple", layer: 0, alpha: 1 }];
    const best = __selectBestMacWindowForTest(windows as any, "Visual Studio Code");
    assert.equal(best, undefined);
  });
});
