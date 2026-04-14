"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const handlers_1 = require("../../src/tools/handlers");
suite("macOS window selection", () => {
    test("prefers exact title match over partial", () => {
        const windows = [
            { id: 10, app: "Safari", title: "", layer: 0, alpha: 1 },
            { id: 11, app: "Code", title: "README.md — Visual Studio Code", layer: 0, alpha: 1 },
            { id: 12, app: "Code", title: "settings.json — Visual Studio Code", layer: 0, alpha: 1 },
            { id: 13, app: "Notes", title: "README.md", layer: 0, alpha: 1 },
        ];
        const best = (0, handlers_1.__selectBestMacWindowForTest)(windows, "README.md");
        strict_1.default.equal(best?.id, 13);
    });
    test("filters non-layer-0 windows", () => {
        const windows = [
            { id: 20, app: "Code", title: "Main", layer: 1, alpha: 1 },
            { id: 21, app: "Code", title: "Main", layer: 0, alpha: 1 },
        ];
        const best = (0, handlers_1.__selectBestMacWindowForTest)(windows, "Main");
        strict_1.default.equal(best?.id, 21);
    });
    test("returns undefined when no reasonable match", () => {
        const windows = [{ id: 30, app: "Safari", title: "Apple", layer: 0, alpha: 1 }];
        const best = (0, handlers_1.__selectBestMacWindowForTest)(windows, "Visual Studio Code");
        strict_1.default.equal(best, undefined);
    });
});
//# sourceMappingURL=macWindowSelection.test.js.map