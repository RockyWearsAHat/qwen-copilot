"use strict";
/**
 * Pure type-coercion helpers shared across provider modules.
 * No side-effects, no imports beyond primitives.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.coerceString = coerceString;
exports.coerceBoolean = coerceBoolean;
exports.coerceNumber = coerceNumber;
exports.coerceInteger = coerceInteger;
exports.stableSerialize = stableSerialize;
exports.nextCallId = nextCallId;
function coerceString(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return undefined;
}
function coerceBoolean(value, fallback) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const lowered = value.toLowerCase().trim();
        if (lowered === "true") {
            return true;
        }
        if (lowered === "false") {
            return false;
        }
    }
    if (typeof value === "number") {
        return value !== 0;
    }
    return fallback;
}
function coerceNumber(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}
function coerceInteger(value, fallback) {
    return Math.max(1, Math.floor(coerceNumber(value, fallback)));
}
function stableSerialize(value) {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
    }
    if (!value || typeof value !== "object") {
        return JSON.stringify(value);
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
        .join(",")}}`;
}
function nextCallId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
//# sourceMappingURL=coercion.js.map