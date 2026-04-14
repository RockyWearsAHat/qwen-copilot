"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const handlers_1 = require("../../src/tools/handlers");
async function writePngArtifact(buffer, label) {
    const outPath = path.join(os.tmpdir(), `local-qwen-${label}-${Date.now()}.png`);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(outPath), buffer);
    return outPath;
}
function isPng(buffer) {
    if (buffer.length < 8)
        return false;
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return sig.every((b, i) => buffer[i] === b);
}
async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}
suite("GUI E2E — screenshot + OCR + (optional) vision", () => {
    test("creates inputTest.md, highlights text, screenshots, OCRs it", async function () {
        const enabled = process.env.LOCAL_QWEN_E2E_GUI === "1";
        if (!enabled) {
            this.skip();
            return;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        strict_1.default.ok(workspaceFolder, "No workspace folder open in extension host.");
        const dirUri = vscode.Uri.joinPath(workspaceFolder.uri, ".local-qwen-e2e");
        const fileUri = vscode.Uri.joinPath(dirUri, "inputTest.md");
        // Keep the OCR target simple: alphanumeric only (tesseract is much more reliable).
        const magicToken = `MAGIC${Date.now()}`;
        const content = [
            "# Input Test",
            "",
            `MagicPlain: ${magicToken}`,
            "",
            `MagicSelect: ${magicToken}`,
            "",
            "(If you can read this in the screenshot, OCR/vision works.)",
            "",
        ].join("\n");
        await vscode.workspace.fs.createDirectory(dirUri);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        // Ensure editor content is exactly as expected (avoid stale buffers).
        await editor.edit((b) => {
            const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            b.replace(full, content);
        });
        await doc.save();
        const selectNeedle = `MagicSelect: ${magicToken}`;
        const idx = doc.getText().indexOf(selectNeedle);
        strict_1.default.ok(idx >= 0, "Failed to locate the MagicSelect line in document.");
        const tokenStart = idx + selectNeedle.indexOf(magicToken);
        const start = doc.positionAt(tokenStart);
        const end = doc.positionAt(tokenStart + magicToken.length);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        // Assert the selection exists (this is the ground truth for "highlighted").
        strict_1.default.equal(editor.selection.isEmpty, false);
        strict_1.default.equal(doc.getText(editor.selection), magicToken);
        // Give VS Code time to visually render the selection before screenshot.
        await sleep(500);
        // Best-effort: ensure VS Code is foreground so window screenshots/OCR make sense.
        // This is intentionally non-fatal (some environments block focus requests).
        try {
            await (0, handlers_1.tool_focus_window)({ windowTitle: "Code", appName: "Visual Studio Code" });
        }
        catch {
            // ignore
        }
        // On macOS, passing windowTitle exercises the non-interactive window targeting path.
        // On Linux, it triggers scrot -u (active window). On Windows it is best-effort only.
        const wantWindow = process.platform !== "win32";
        const screenshotArgs = wantWindow ? { windowTitle: "Code" } : {};
        const shot = (await (0, handlers_1.tool_take_screenshot)(screenshotArgs));
        if (!shot.success) {
            throw new Error(`Screenshot failed: ${shot.error ?? "unknown error"}`);
        }
        strict_1.default.equal(shot.format, "png");
        strict_1.default.ok(typeof shot.image === "string" && shot.image.length > 1000, "Missing base64 image.");
        const buf = Buffer.from(shot.image, "base64");
        strict_1.default.ok(buf.length > 10_000, `Screenshot too small (${buf.length} bytes).`);
        strict_1.default.ok(isPng(buf), "Screenshot is not a valid PNG (bad signature).");
        // OCR must find our unique text.
        const ocr = (await (0, handlers_1.tool_ocr_find_text)({
            image: shot.image,
            query: magicToken,
            isRegexp: false,
            maxResults: 5,
            minConfidence: 35,
            origin: { x: 0, y: 0 },
        }));
        if (!ocr.success) {
            throw new Error(`OCR failed: ${ocr.error ?? "unknown error"}. ` +
                `Install tesseract (macOS: brew install tesseract) and re-run with LOCAL_QWEN_E2E_GUI=1.`);
        }
        if ((ocr.matchCount ?? 0) <= 0) {
            const artifactPath = await writePngArtifact(buf, "inputTest-ocr-miss");
            throw new Error(`OCR did not find the magic token in the screenshot. ` +
                `Wrote artifact for inspection: ${artifactPath}`);
        }
        // Optional: vision verification (requires Ollama running + a vision-capable model configured).
        const visionEnabled = process.env.LOCAL_QWEN_E2E_VISION === "1";
        const visionStrict = process.env.LOCAL_QWEN_E2E_VISION_STRICT === "1";
        if (visionEnabled) {
            const prompt = "You are verifying an automated GUI test. " +
                "Confirm whether the screenshot shows a VS Code editor with a markdown file open, " +
                `and that the exact token '${magicToken}' is visible and appears selected/highlighted. ` +
                "Reply in 1-3 sentences.";
            const vision = (await (0, handlers_1.tool_analyze_image)({ image: shot.image, prompt }));
            if (!vision.success) {
                throw new Error(`Vision analysis failed: ${vision.error ?? "unknown error"}`);
            }
            const analysis = String(vision.analysis ?? "");
            // If the model doesn\'t support vision, treat it as a failure in strict mode.
            if (visionStrict) {
                strict_1.default.equal(vision.visionSupported, true, "Configured model does not appear vision-capable.");
            }
            // Best-effort checks: require token visibility; optionally require highlight wording in strict mode.
            strict_1.default.ok(analysis.toLowerCase().includes(magicToken.toLowerCase()), "Vision model did not mention the expected token.");
            if (visionStrict) {
                strict_1.default.match(analysis.toLowerCase(), /highlight|selected|selection/, "Vision model did not confirm highlighted/selected state.");
            }
        }
        // Cleanup.
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        await vscode.workspace.fs.delete(dirUri, { recursive: true, useTrash: false });
        // Optional artifact dump for manual inspection.
        const artifacts = process.env.LOCAL_QWEN_E2E_ARTIFACTS === "1";
        if (artifacts) {
            const outPath = await writePngArtifact(buf, "inputTest");
            // eslint-disable-next-line no-console
            console.log(`Wrote screenshot artifact: ${outPath}`);
        }
    });
});
//# sourceMappingURL=guiE2eInputTest.test.js.map