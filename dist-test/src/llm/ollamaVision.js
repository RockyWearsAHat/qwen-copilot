"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLikelyVisionModel = isLikelyVisionModel;
exports.prepareMessagesWithVision = prepareMessagesWithVision;
/**
 * Transparent vision support for any Ollama model.
 *
 * - Vision-capable models (llava, bakllava, moondream, etc.): images sent directly
 * - Non-vision models: images are analyzed by a configured/available vision model,
 *   and extracted screen state is injected as text for the base model
 */
const KNOWN_VISION_MODELS = [
    "llava",
    "bakllava",
    "moondream",
    "cogvlm",
    "minicpm-v",
    "llava-llama3",
    "llava-phi3",
    "internvl",
    "qwen-vl",
    "qwen2-vl",
];
function isLikelyVisionModel(modelName) {
    const lower = modelName.toLowerCase();
    return KNOWN_VISION_MODELS.some((vm) => lower.includes(vm));
}
/**
 * Prepare messages for Ollama, handling image content transparently.
 *
 * If the model is not a vision model but messages contain images,
 * we pre-process images through a vision model (if available) or
 * attach a text description of the image metadata.
 */
async function prepareMessagesWithVision(messages, model, ollamaUrl, output, 
/** When provided, overrides the name-based heuristic for native vision detection. */
modelSupportsVision, 
/** Preferred vision model for screenshot-state extraction when base model lacks vision. */
configuredVisionModel) {
    const visionMessages = messages;
    const hasImages = visionMessages.some((m) => m.images && m.images.length > 0);
    if (!hasImages) {
        return messages;
    }
    const nativeVision = modelSupportsVision ?? isLikelyVisionModel(model);
    if (nativeVision) {
        output.appendLine(`[vision] Model ${model} supports vision natively.`);
        return messages;
    }
    output.appendLine(`[vision] Model ${model} does not support vision. Enriching messages with extracted screenshot state.`);
    let visionModel = configuredVisionModel?.trim() || null;
    if (visionModel) {
        output.appendLine(`[vision] Using configured vision model: ${visionModel}`);
    }
    if (!visionModel) {
        try {
            const resp = await fetch(`${ollamaUrl}/api/tags`);
            if (resp.ok) {
                const data = (await resp.json());
                const available = data.models.map((m) => m.name);
                visionModel = available.find((n) => isLikelyVisionModel(n)) ?? null;
                if (visionModel) {
                    output.appendLine(`[vision] Found available vision model: ${visionModel}`);
                }
            }
        }
        catch {
            output.appendLine("[vision] Could not query Ollama for available models.");
        }
    }
    const processed = [];
    for (const msg of visionMessages) {
        if (!msg.images || msg.images.length === 0) {
            processed.push(msg);
            continue;
        }
        if (visionModel) {
            const descriptions = [];
            for (const img of msg.images) {
                try {
                    const visionResp = await fetch(`${ollamaUrl}/api/generate`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: visionModel,
                            prompt: [
                                "Extract the CURRENT viewed state from this screenshot for a non-vision coding model.",
                                "Return concise plain text with these sections:",
                                "1) Visible Screen/Route",
                                "2) Primary UI State",
                                "3) Errors/Warnings",
                                "4) Asset/Network State",
                                "5) Key Visible Text",
                                "Focus on concrete, directly visible facts only.",
                            ].join("\n"),
                            images: [img],
                            stream: false,
                            options: { num_predict: 1024 },
                        }),
                    });
                    if (visionResp.ok) {
                        const visionData = (await visionResp.json());
                        descriptions.push(visionData.response);
                    }
                    else {
                        descriptions.push("[Image could not be analyzed]");
                    }
                }
                catch {
                    descriptions.push("[Image analysis failed]");
                }
            }
            const imageContext = descriptions
                .map((d, i) => `[Screenshot State ${i + 1}]\n${d}`)
                .join("\n\n");
            processed.push({
                role: msg.role,
                content: `${msg.content}\n\n${imageContext}`,
            });
        }
        else {
            const sizeInfo = msg.images
                .map((img, i) => {
                const sizeKb = Math.round((img.length * 3) / 4 / 1024);
                return `[Image ${i + 1}: ${sizeKb}KB PNG — no vision model available]`;
            })
                .join("\n");
            processed.push({
                role: msg.role,
                content: `${msg.content}\n\n${sizeInfo}\n\nTo analyze images, install a vision model: ollama pull llava`,
            });
        }
    }
    return processed;
}
//# sourceMappingURL=ollamaVision.js.map