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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRegistry = void 0;
const handlerModule = __importStar(require("./handlers"));
const vscode = __importStar(require("vscode"));
const handlerReflection_1 = require("./handlerReflection");
const toolSourceParser_1 = require("./toolSourceParser");
const machineInteractionPolicy_1 = require("./machineInteractionPolicy");
/**
 * Rich schema definitions for every local tool handler.
 *
 * Providing accurate descriptions and parameter schemas gives the LLM the
 * information it needs to decide WHICH tool to call and WHAT arguments to pass,
 * rather than guessing from the tool name alone.
 */
const TOOL_SCHEMA_MAP = {
    read_file: {
        description: "Read a range of lines from a file inside the workspace. Use this to inspect file contents before editing. Prefer reading broad ranges once over many small reads.",
        parameters: {
            type: "object",
            required: ["filePath"],
            properties: {
                filePath: { type: "string", description: "Absolute path to the file to read." },
                startLine: { type: "number", description: "1-based first line to return (default: 1)." },
                endLine: {
                    type: "number",
                    description: "1-based last line to return (default: startLine+200).",
                },
            },
            additionalProperties: false,
        },
    },
    write_file: {
        description: "Create or fully overwrite a file with the given content. Use for new files or wholesale replacements. Prefer edit_file for surgical changes to existing files.",
        parameters: {
            type: "object",
            required: ["filePath", "content"],
            properties: {
                filePath: {
                    type: "string",
                    description: "Absolute path to the file to create or overwrite.",
                },
                content: { type: "string", description: "Full UTF-8 text to write." },
                overwrite: {
                    type: "boolean",
                    description: "If false, refuse to overwrite an existing file (default: true).",
                },
            },
            additionalProperties: false,
        },
    },
    edit_file: {
        description: "Replace a specific line range inside an existing file. Provide the exact lines to replace and the new text. Both startLine and endLine are 1-based and inclusive. Use this instead of write_file when modifying only part of a file.",
        parameters: {
            type: "object",
            required: ["filePath", "startLine", "endLine", "newText"],
            properties: {
                filePath: { type: "string", description: "Absolute path to the file to edit." },
                startLine: { type: "number", description: "1-based first line to replace." },
                endLine: { type: "number", description: "1-based last line to replace (inclusive)." },
                newText: {
                    type: "string",
                    description: "Replacement text (may span multiple lines). An empty string deletes the range.",
                },
            },
            additionalProperties: false,
        },
    },
    list_dir: {
        description: "List the immediate children of a directory. " +
            "Only call this if the specific path you need to inspect is NOT already shown in the workspace tree in your context. " +
            "If the workspace snapshot already shows the directory contents, do not call this — use the snapshot instead.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Absolute directory path to list (defaults to workspace root).",
                },
            },
            additionalProperties: false,
        },
    },
    file_search: {
        description: "Search for files by name or glob pattern. " +
            "Only use this when you need to find a file whose location is genuinely unknown and not shown in the workspace snapshot. " +
            "Do not use this to confirm that a file exists — the workspace tree already tells you that.",
        parameters: {
            type: "object",
            required: ["query"],
            properties: {
                query: {
                    type: "string",
                    description: "Glob pattern or partial file name (e.g. '**/*.ts', 'platformerGame').",
                },
                maxResults: {
                    type: "number",
                    description: "Maximum number of results to return (default: 100).",
                },
            },
            additionalProperties: false,
        },
    },
    grep_search: {
        description: "Search for a text pattern or regex within workspace files. Returns file paths and matching lines. Use to locate symbol definitions, usages, or specific strings without reading every file.",
        parameters: {
            type: "object",
            required: ["query"],
            properties: {
                query: { type: "string", description: "The text or regex pattern to search for." },
                isRegexp: {
                    type: "boolean",
                    description: "True to treat query as a regular expression (default: false).",
                },
                includePattern: {
                    type: "string",
                    description: "Glob restricting which files to search (e.g. 'src/**/*.ts').",
                },
                maxResults: {
                    type: "number",
                    description: "Maximum number of match lines to return (default: 200).",
                },
            },
            additionalProperties: false,
        },
    },
    replace_in_files: {
        description: "Replace all occurrences of a string across multiple files matching a glob pattern. Use for bulk renames or consistent string substitutions. Returns the count of replacements made.",
        parameters: {
            type: "object",
            required: ["from", "to"],
            properties: {
                from: { type: "string", description: "The exact string to search for and replace." },
                to: { type: "string", description: "The replacement string." },
                includePattern: {
                    type: "string",
                    description: "Glob limiting which files to modify (default: '**/*').",
                },
                excludePattern: { type: "string", description: "Glob for files to skip." },
                maxFiles: {
                    type: "number",
                    description: "Maximum number of files to modify (default: 50).",
                },
            },
            additionalProperties: false,
        },
    },
    run_in_terminal: {
        description: "Execute a shell command for build, test, install, or runtime tasks. " +
            "FORBIDDEN uses: do NOT run find, ls, tree, cat, head, tail, or any command whose only purpose is to discover or display files — " +
            "the workspace file tree is already injected in your context and is authoritative. " +
            "Running a shell command to answer a question the workspace snapshot already answers wastes a turn and must not happen.",
        parameters: {
            type: "object",
            required: ["command"],
            properties: {
                command: { type: "string", description: "The shell command to execute." },
                cwd: { type: "string", description: "Working directory (defaults to workspace root)." },
                timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)." },
                background: {
                    type: "boolean",
                    description: "Run asynchronously; returns a process ID (default: false).",
                },
                showTerminal: {
                    type: "boolean",
                    description: "When true, run command in a visible VS Code terminal instead of hidden child process execution (default: false).",
                },
            },
            additionalProperties: false,
        },
    },
    get_terminal_output: {
        description: "Retrieve buffered output from a background terminal process previously started with run_in_terminal. Use to check if a background build or server has finished or produced errors.",
        parameters: {
            type: "object",
            required: ["id"],
            properties: {
                id: {
                    type: "string",
                    description: "Process ID returned by run_in_terminal with background=true.",
                },
            },
            additionalProperties: false,
        },
    },
    kill_terminal: {
        description: "Terminate a background terminal process previously started with run_in_terminal. Call this to clean up after a background server or watcher is no longer needed.",
        parameters: {
            type: "object",
            required: ["id"],
            properties: {
                id: {
                    type: "string",
                    description: "Process ID returned by run_in_terminal with background=true.",
                },
            },
            additionalProperties: false,
        },
    },
    // ── User Acceptance Checklist (.github/completion-checklist.md) ────
    // READ-ONLY for the agent. Written by the user. Never modified by the agent.
    get_completion_checklist: {
        description: "READ-ONLY. Load the USER's .github/completion-checklist.md acceptance criteria. This is written by the user before the conversation and defines what 'done' means. Call on the FIRST turn and again in the final post-op verification pass. The agent must NEVER write to this file. For the agent's own internal sub-task tracking use create_agent_checklist / get_agent_checklist / update_agent_checklist_item.",
        parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    // ── Agent Internal Checklist (.github/agent-checklist.md) ───────────
    // Created fresh per request by the agent. Entirely separate from the user's file.
    create_agent_checklist: {
        description: "Create (or replace) .github/agent-checklist.md — the agent's private, per-request work plan. Call this on the first turn to decompose the request into specific, ordered sub-tasks (10–50 items for complex work). This file is SEPARATE from and does NOT overwrite completion-checklist.md. Group items by logical section. Items should be concrete actions, not vague milestones.",
        parameters: {
            type: "object",
            required: ["title", "items"],
            properties: {
                title: {
                    type: "string",
                    description: "Short descriptive title for the work plan (e.g. '3D Parkour Game Implementation').",
                },
                items: {
                    type: "array",
                    items: { type: "string" },
                    description: "Ordered list of specific, concrete sub-tasks covering the full request scope. NOT high-level milestones (those go in agent_progress). Each item should map to one or a few related file changes.",
                },
            },
            additionalProperties: false,
        },
    },
    get_agent_checklist: {
        description: "Read and parse .github/agent-checklist.md — the agent's private internal work plan. Call regularly to see which sub-tasks are still pending. Returns checked/unchecked items with a progress summary.",
        parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    update_agent_checklist_item: {
        description: "Mark a specific item in .github/agent-checklist.md as done or not done. Call after completing each sub-task. Matched by partial text (case-insensitive).",
        parameters: {
            type: "object",
            required: ["itemText", "checked"],
            properties: {
                itemText: {
                    type: "string",
                    description: "Partial text of the agent checklist item to update.",
                },
                checked: {
                    type: "boolean",
                    description: "True to mark done (- [x]), false to uncheck (- [ ]).",
                },
            },
            additionalProperties: false,
        },
    },
    // ── Vision / Screenshot ──────────────────────────────────────────────
    take_screenshot: {
        description: "Capture a screenshot of the screen or a specific window/region, returned as base64 PNG. Use to visually verify GUI apps, websites, desktop apps. On macOS uses screencapture, on Linux uses scrot/gnome-screenshot. Also returns best-effort metadata (origin/size) to help map OCR results to absolute screen coordinates.",
        parameters: {
            type: "object",
            properties: {
                windowTitle: {
                    type: "string",
                    description: "Capture only the window with this title. Omit for full screen.",
                },
                region: {
                    type: "object",
                    description: "Capture a specific rectangle.",
                    properties: {
                        x: { type: "number", description: "X of top-left corner." },
                        y: { type: "number", description: "Y of top-left corner." },
                        width: { type: "number", description: "Width in pixels." },
                        height: { type: "number", description: "Height in pixels." },
                    },
                },
                delay: { type: "number", description: "Seconds to wait before capture (default: 0)." },
            },
            additionalProperties: false,
        },
    },
    ocr_find_text: {
        description: "Run local OCR over a screenshot image and return bounding boxes + coordinates for matching text. Use this to turn 'click the \"OK\" button' into pixel coordinates before calling gui_click. Requires tesseract to be installed on the host.",
        parameters: {
            type: "object",
            required: ["image", "query"],
            properties: {
                image: { type: "string", description: "Base64-encoded screenshot image (PNG/JPEG)." },
                query: {
                    type: "string",
                    description: "Text (or regex) to locate in the image.",
                },
                isRegexp: {
                    type: "boolean",
                    description: "Treat query as a regex (default: false).",
                },
                maxResults: {
                    type: "number",
                    description: "Maximum number of matches to return (default: 20).",
                },
                minConfidence: {
                    type: "number",
                    description: "Minimum OCR confidence (0-100, default: 0).",
                },
                origin: {
                    type: "object",
                    description: "Optional absolute screen origin offset (x,y) for the screenshot. When provided, returns absolute click coordinates in addition to image-local coordinates.",
                    properties: {
                        x: { type: "number" },
                        y: { type: "number" },
                    },
                },
            },
            additionalProperties: false,
        },
    },
    analyze_image: {
        description: "Send an image (base64 or file path) to the Ollama model for visual analysis. Use to understand screenshots, identify UI elements, read text from images. Returns the model's textual analysis.",
        parameters: {
            type: "object",
            required: ["image"],
            properties: {
                image: { type: "string", description: "Base64-encoded image data OR absolute file path." },
                prompt: {
                    type: "string",
                    description: "Question about the image (default: 'Describe what you see').",
                },
            },
            additionalProperties: false,
        },
    },
    // ── GUI Interaction ──────────────────────────────────────────────────
    gui_click: {
        description: "Simulate a mouse click at screen coordinates. Use after take_screenshot to interact with GUI apps, browsers, desktop apps.",
        parameters: {
            type: "object",
            required: ["x", "y"],
            properties: {
                x: { type: "number", description: "X coordinate on screen." },
                y: { type: "number", description: "Y coordinate on screen." },
                button: {
                    type: "string",
                    enum: ["left", "right", "middle"],
                    description: "Mouse button (default: 'left').",
                },
                doubleClick: { type: "boolean", description: "Perform double-click (default: false)." },
            },
            additionalProperties: false,
        },
    },
    gui_type: {
        description: "Simulate keyboard text input. Types text as if user typed it. Use after gui_click to fill forms or type commands.",
        parameters: {
            type: "object",
            required: ["text"],
            properties: {
                text: { type: "string", description: "Text to type. Use \\n for Enter, \\t for Tab." },
                modifiers: {
                    type: "array",
                    items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift"] },
                    description: "Modifier keys to hold while typing.",
                },
                delayMs: { type: "number", description: "Delay between keystrokes in ms (default: 50)." },
            },
            additionalProperties: false,
        },
    },
    gui_scroll: {
        description: "Simulate mouse scroll at screen coordinates. Use for scrolling web pages, documents, or scrollable UI elements.",
        parameters: {
            type: "object",
            required: ["x", "y", "direction"],
            properties: {
                x: { type: "number", description: "X coordinate on screen." },
                y: { type: "number", description: "Y coordinate on screen." },
                direction: {
                    type: "string",
                    enum: ["up", "down", "left", "right"],
                    description: "Scroll direction.",
                },
                amount: { type: "number", description: "Scroll units (default: 3)." },
            },
            additionalProperties: false,
        },
    },
    gui_key: {
        description: "Press a key or key combination. Use for shortcuts (Cmd+Q, Ctrl+C, Escape, Enter, etc.) during GUI testing.",
        parameters: {
            type: "object",
            required: ["key"],
            properties: {
                key: {
                    type: "string",
                    description: "Key name: 'enter', 'escape', 'tab', 'space', 'up', 'down', 'left', 'right', 'backspace', 'delete', 'f1'-'f12', or any character.",
                },
                modifiers: {
                    type: "array",
                    items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift"] },
                    description: "Modifier keys (e.g. ['cmd', 'shift']).",
                },
            },
            additionalProperties: false,
        },
    },
    gui_key_hold: {
        description: "Press and hold a key for a short duration then release. Mainly useful for modifier keys during GUI automation. On macOS this is best-effort and primarily supports modifiers via cliclick.",
        parameters: {
            type: "object",
            required: ["key"],
            properties: {
                key: {
                    type: "string",
                    description: "Key to hold, e.g. 'shift', 'ctrl', 'cmd', 'alt'.",
                },
                durationMs: {
                    type: "number",
                    description: "How long to hold in milliseconds (default: 300).",
                },
            },
            additionalProperties: false,
        },
    },
    // ── Window & Process Management ──────────────────────────────────────
    list_windows: {
        description: "List all visible application windows. Returns titles, app names, positions, sizes. Use to find windows to screenshot or interact with.",
        parameters: {
            type: "object",
            properties: {
                appName: { type: "string", description: "Filter to windows from this application." },
            },
            additionalProperties: false,
        },
    },
    focus_window: {
        description: "Bring a window to the foreground. Use before gui_click/gui_type to ensure correct window gets input.",
        parameters: {
            type: "object",
            required: ["windowTitle"],
            properties: {
                windowTitle: { type: "string", description: "Title (or partial) of the window to focus." },
                appName: {
                    type: "string",
                    description: "Application name to disambiguate similar titles.",
                },
            },
            additionalProperties: false,
        },
    },
    launch_app: {
        description: "Launch an application or URL. Use to start the app-under-test before GUI testing. On macOS uses 'open', on Linux uses 'xdg-open'.",
        parameters: {
            type: "object",
            required: ["target"],
            properties: {
                target: {
                    type: "string",
                    description: "App path, bundle ID, or URL (e.g. 'http://localhost:3000').",
                },
                args: { type: "array", items: { type: "string" }, description: "Command-line arguments." },
                waitForWindow: {
                    type: "boolean",
                    description: "Wait for a window to appear (default: true).",
                },
                timeout: { type: "number", description: "Max wait in ms (default: 10000)." },
            },
            additionalProperties: false,
        },
    },
    wait_for_condition: {
        description: "Poll until a condition is met: file exists, port listening, process running, or text on screen. Use to sync between launching an app and interacting with it.",
        parameters: {
            type: "object",
            required: ["type"],
            properties: {
                type: {
                    type: "string",
                    enum: ["file_exists", "port_open", "process_running", "screen_contains"],
                    description: "Condition type.",
                },
                target: {
                    type: "string",
                    description: "File path, port number, process name, or screen text.",
                },
                timeout: { type: "number", description: "Max wait in ms (default: 30000)." },
                interval: { type: "number", description: "Poll interval in ms (default: 1000)." },
            },
            additionalProperties: false,
        },
    },
    // ── Diagnostics & Workspace Intelligence ─────────────────────────────
    get_diagnostics: {
        description: "Get VS Code diagnostics (errors, warnings) for a file or the entire workspace. Use after code changes to verify zero errors.",
        parameters: {
            type: "object",
            properties: {
                filePath: { type: "string", description: "File to check. Omit for all files." },
                severity: {
                    type: "string",
                    enum: ["error", "warning", "info", "hint"],
                    description: "Min severity filter (default: 'error').",
                },
            },
            additionalProperties: false,
        },
    },
    get_workspace_symbols: {
        description: "Search for symbols (functions, classes, variables, types) across the workspace by name. Use to quickly locate definitions.",
        parameters: {
            type: "object",
            required: ["query"],
            properties: {
                query: { type: "string", description: "Symbol name or partial name." },
                maxResults: { type: "number", description: "Max results (default: 50)." },
            },
            additionalProperties: false,
        },
    },
    get_document_symbols: {
        description: "Get all symbols in a specific file — functions, classes, methods, imports. Use to understand file structure before editing.",
        parameters: {
            type: "object",
            required: ["filePath"],
            properties: {
                filePath: { type: "string", description: "Absolute file path." },
            },
            additionalProperties: false,
        },
    },
    get_references: {
        description: "Find all references to a symbol at a file location. Use to understand impact before modifying a function/class/variable.",
        parameters: {
            type: "object",
            required: ["filePath", "line", "character"],
            properties: {
                filePath: { type: "string", description: "File containing the symbol." },
                line: { type: "number", description: "1-based line number." },
                character: { type: "number", description: "0-based character offset." },
            },
            additionalProperties: false,
        },
    },
    get_definition: {
        description: "Jump to a symbol's definition. Returns file and line where it is defined. Use to trace imports and declarations.",
        parameters: {
            type: "object",
            required: ["filePath", "line", "character"],
            properties: {
                filePath: { type: "string", description: "File containing the symbol reference." },
                line: { type: "number", description: "1-based line number." },
                character: { type: "number", description: "0-based character offset." },
            },
            additionalProperties: false,
        },
    },
    // ── HTTP / Network Testing ───────────────────────────────────────────
    http_request: {
        description: "Make an HTTP request and return the response. Use to test REST APIs, verify servers, or fetch data.",
        parameters: {
            type: "object",
            required: ["url"],
            properties: {
                url: { type: "string", description: "Full URL (e.g. 'http://localhost:3000/api/users')." },
                method: {
                    type: "string",
                    enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
                    description: "HTTP method (default: 'GET').",
                },
                headers: { type: "object", description: "Request headers as key-value pairs." },
                body: { type: "string", description: "Request body for POST/PUT/PATCH." },
                timeout: { type: "number", description: "Timeout in ms (default: 10000)." },
                followRedirects: { type: "boolean", description: "Follow redirects (default: true)." },
            },
            additionalProperties: false,
        },
    },
    // ── Autonomous Loop Control ──────────────────────────────────────────
    agent_progress: {
        description: "Report USER-FACING high-level progress milestones. This is the user's window into what the agent is doing — keep items high-level (5–10 across the whole task). Do NOT call this after every checklist sub-task; call it only when a major logical section of work is complete (e.g. 'scaffold complete', 'player controller written', 'physics integrated'). The detailed internal tracking lives in the completion checklist — this is the executive summary for the user.",
        parameters: {
            type: "object",
            required: ["completed", "remaining", "status"],
            properties: {
                completed: {
                    type: "array",
                    items: { type: "string" },
                    description: "HIGH-LEVEL milestones completed so far (not individual sub-tasks).",
                },
                remaining: {
                    type: "array",
                    items: { type: "string" },
                    description: "HIGH-LEVEL milestones still remaining.",
                },
                status: {
                    type: "string",
                    enum: ["in_progress", "blocked", "completed", "failed"],
                    description: "Overall status.",
                },
                blockerDescription: { type: "string", description: "If blocked, describe the blocker." },
                nextAction: { type: "string", description: "Planned next action." },
            },
            additionalProperties: false,
        },
    },
};
class ToolRegistry {
    output;
    parser;
    handlerMap;
    executableTools = [];
    constructor(output) {
        this.output = output;
        this.parser = new toolSourceParser_1.ToolSourceParser(output);
        this.handlerMap = this.buildHandlerMap();
    }
    async refresh() {
        const discovered = await this.parser.discoverToolNames();
        const names = [...discovered].filter((name) => this.handlerMap.has(name)).sort();
        this.executableTools = names.map((name) => {
            const schema = TOOL_SCHEMA_MAP[name];
            return {
                name,
                description: schema?.description ?? `Executes local tool: ${name}`,
                parameters: schema?.parameters ?? { type: "object", additionalProperties: true },
            };
        });
        this.output.appendLine(`[local-qwen] Discovered tools: ${names.join(", ") || "(none)"}`);
    }
    getExecutableTools() {
        return this.executableTools;
    }
    getRegisteredHandlerNames() {
        return [...this.handlerMap.keys()].sort();
    }
    async execute(name, args) {
        const configuration = vscode.workspace.getConfiguration("localQwen");
        const machineToolsEnabled = configuration.get("enableMachineInteractionTools", false);
        if (!machineToolsEnabled && (0, machineInteractionPolicy_1.isMachineInteractionToolName)(name)) {
            return {
                success: false,
                error: `Tool '${name}' is disabled. Enable localQwen.enableMachineInteractionTools to allow screenshot/OCR/GUI interaction tools.`,
            };
        }
        const handler = this.handlerMap.get(name);
        if (!handler) {
            throw new Error(`No executable handler registered for tool '${name}'.`);
        }
        return handler(args);
    }
    buildHandlerMap() {
        return (0, handlerReflection_1.reflectToolHandlers)(handlerModule);
    }
}
exports.ToolRegistry = ToolRegistry;
//# sourceMappingURL=toolRegistry.js.map