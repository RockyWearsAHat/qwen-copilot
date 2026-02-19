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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const localAgent_1 = require("./agent/localAgent");
const localLanguageModelProvider_1 = require("./llm/localLanguageModelProvider");
const toolRegistry_1 = require("./tools/toolRegistry");
function activate(context) {
    const output = vscode.window.createOutputChannel('Local Qwen Agent');
    const registry = new toolRegistry_1.ToolRegistry(output);
    const runner = new localAgent_1.LocalAgentRunner(registry, output);
    const modelProvider = new localLanguageModelProvider_1.LocalLanguageModelProvider(output);
    const participant = vscode.chat.createChatParticipant('localQwen.agent', async (request, _chatContext, stream, token) => {
        await runner.handleRequest(request, stream, token);
    });
    participant.iconPath = new vscode.ThemeIcon('hubot');
    const refreshCommand = vscode.commands.registerCommand('localQwen.refreshTools', async () => {
        await registry.refresh();
        const tools = registry.getExecutableTools();
        vscode.window.showInformationMessage(`Local Qwen Agent discovered ${tools.length} executable tools.`);
    });
    const providerRegistration = vscode.lm.registerLanguageModelChatProvider('local-ollama', modelProvider);
    context.subscriptions.push(output, participant, refreshCommand, providerRegistration);
}
function deactivate() {
    // no-op
}
//# sourceMappingURL=extension.js.map