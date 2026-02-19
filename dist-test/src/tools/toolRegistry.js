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
const handlerReflection_1 = require("./handlerReflection");
const toolSourceParser_1 = require("./toolSourceParser");
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
        const names = [...discovered]
            .filter((name) => this.handlerMap.has(name))
            .sort();
        this.executableTools = names.map((name) => ({
            name,
            description: `Executes local tool: ${name}`,
            parameters: {
                type: "object",
                additionalProperties: true,
            },
        }));
        this.output.appendLine(`[local-qwen] Executable tools: ${names.join(", ") || "(none)"}`);
    }
    getExecutableTools() {
        return this.executableTools;
    }
    getRegisteredHandlerNames() {
        return [...this.handlerMap.keys()].sort();
    }
    async execute(name, args) {
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