#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
}

function parseIntArg(flag, fallback) {
  const raw = parseArg(flag, "");
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIndexes(raw) {
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

function parseRanges(raw) {
  if (!raw.trim()) {
    return [];
  }

  const ranges = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
      continue;
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }

    ranges.push({ start: Math.min(start, end), end: Math.max(start, end) });
  }

  return ranges;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/import-copilot-compat-tests.mjs --src <repo-or-folder> [--out <json-path>] [--limit <n>] [--start <n>] [--end <n>] [--indexes <csv>] [--range <a-b,c-d>]",
      "",
      "Behavior:",
      "  - Strict mode: imports only explicit test prompts/messages from structured JSON artifacts.",
      "  - Never synthesizes prompts from test titles.",
      "  - Preserves test payloads exactly when prompt/messages fields exist.",
    ].join("\n"),
  );
}

async function walk(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    const normalizedPath = fullPath.replace(/\\/g, "/").toLowerCase();
    const isJson = ext === ".json";
    const isCanonicalIntentArtifact = normalizedPath.includes("/test/intent/");
    const isCanonicalConversationArtifact =
      normalizedPath.includes("/test/scenarios/") &&
      normalizedPath.endsWith(".conversation.json");

    if (
      isJson &&
      (isCanonicalIntentArtifact || isCanonicalConversationArtifact)
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

function coerceString(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed;
}

function getFirstPresentValue(object, keys) {
  if (!object || typeof object !== "object") {
    return undefined;
  }

  const record = object;
  const lowerToActual = new Map(
    Object.keys(record).map((key) => [key.toLowerCase(), key]),
  );

  for (const key of keys) {
    const directValue = record[key];
    if (typeof directValue !== "undefined") {
      return directValue;
    }

    const normalized = String(key).toLowerCase();
    const mappedKey = lowerToActual.get(normalized);
    if (mappedKey) {
      return record[mappedKey];
    }
  }

  return undefined;
}

function coerceStringArray(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function coerceNonNegativeInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return fallback;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const normalized = messages
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }

      const candidate = entry;
      const roleRaw = coerceString(
        getFirstPresentValue(candidate, ["role"]),
      ).toLowerCase();
      const role =
        roleRaw === "assistant" || roleRaw === "system" || roleRaw === "tool"
          ? roleRaw
          : "user";
      const content = coerceString(
        getFirstPresentValue(candidate, ["content", "text", "message"]),
      );

      if (!content) {
        return undefined;
      }

      return { role, content };
    })
    .filter(Boolean);

  return normalized.length > 0 ? normalized : undefined;
}

function pickFirstString(object, keys) {
  for (const key of keys) {
    const value = coerceString(getFirstPresentValue(object, [key]));
    if (value) {
      return value;
    }
  }
  return "";
}

function toCompatibilityCase(object, source, sourceIndex) {
  const prompt = pickFirstString(object, [
    "prompt",
    "userPrompt",
    "request",
    "Request",
  ]);
  const messages =
    normalizeMessages(getFirstPresentValue(object, ["messages"])) ??
    normalizeMessages(getFirstPresentValue(object, ["chatMessages"])) ??
    normalizeMessages(getFirstPresentValue(object, ["inputMessages"])) ??
    normalizeMessages(getFirstPresentValue(object, ["conversation"]));

  if (!prompt && !messages) {
    return undefined;
  }

  const name =
    pickFirstString(object, ["name", "title", "testName", "id"]) ||
    `${source}#${sourceIndex}`;
  const expectedIntent = pickFirstString(object, ["Intent", "intent"]);
  const location = pickFirstString(object, ["Location", "location"]);

  const minToolCallsRaw = getFirstPresentValue(object, ["minToolCalls"]);
  const maxToolCallsRaw = getFirstPresentValue(object, ["maxToolCalls"]);
  const minToolCalls =
    typeof minToolCallsRaw === "undefined"
      ? undefined
      : coerceNonNegativeInteger(minToolCallsRaw, 0);
  const maxToolCalls =
    typeof maxToolCallsRaw === "undefined"
      ? undefined
      : coerceNonNegativeInteger(
          maxToolCallsRaw,
          typeof minToolCalls === "number" ? minToolCalls : 0,
        );

  const allowedTools =
    coerceStringArray(getFirstPresentValue(object, ["allowedTools"])) ??
    coerceStringArray(getFirstPresentValue(object, ["allowedToolNames"]));
  const forbiddenTools =
    coerceStringArray(getFirstPresentValue(object, ["forbiddenTools"])) ??
    coerceStringArray(getFirstPresentValue(object, ["forbiddenToolNames"]));

  const normalized = {
    name,
    ...(prompt ? { prompt } : {}),
    ...(messages ? { messages } : {}),
    ...(expectedIntent ? { expectedIntent } : {}),
    ...(location ? { location } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(forbiddenTools ? { forbiddenTools } : {}),
    ...(typeof minToolCalls === "number" ? { minToolCalls } : {}),
    ...(typeof maxToolCalls === "number"
      ? {
          maxToolCalls:
            typeof minToolCalls === "number"
              ? Math.max(minToolCalls, maxToolCalls)
              : maxToolCalls,
        }
      : {}),
    source,
    sourceIndex,
  };

  return normalized;
}

function collectCasesFromJsonNode(node, source, sink) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      collectCasesFromJsonNode(node[index], source, sink);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const candidate = toCompatibilityCase(node, source, sink.length);
  if (candidate) {
    sink.push(candidate);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      collectCasesFromJsonNode(value, source, sink);
    }
  }
}

function applyIndexFilters(cases, start, endExclusive, indexes, ranges) {
  const selectedIndexes = new Set();

  if (indexes.length > 0) {
    for (const index of indexes) {
      if (index >= 0 && index < cases.length) {
        selectedIndexes.add(index);
      }
    }
  }

  if (ranges.length > 0) {
    for (const range of ranges) {
      for (let index = range.start; index <= range.end; index += 1) {
        if (index >= 0 && index < cases.length) {
          selectedIndexes.add(index);
        }
      }
    }
  }

  if (selectedIndexes.size > 0) {
    return [...selectedIndexes]
      .sort((left, right) => left - right)
      .map((index) => cases[index]);
  }

  const normalizedStart = Math.max(0, start);
  const normalizedEnd =
    endExclusive > 0 ? Math.min(cases.length, endExclusive) : cases.length;

  if (normalizedStart >= normalizedEnd) {
    return [];
  }

  return cases.slice(normalizedStart, normalizedEnd);
}

async function main() {
  const sourceRoot = parseArg("--src");
  const outPath = parseArg(
    "--out",
    path.resolve(
      process.cwd(),
      "test/fixtures/copilot-compat-cases.generated.json",
    ),
  );
  const limit = parseIntArg("--limit", 0);
  const start = parseIntArg("--start", 0);
  const endExclusive = parseIntArg("--end", 0);
  const indexes = parseIndexes(parseArg("--indexes", ""));
  const ranges = parseRanges(parseArg("--range", ""));

  if (!sourceRoot || sourceRoot === "--help" || sourceRoot === "-h") {
    printUsage();
    process.exit(sourceRoot ? 0 : 1);
  }

  const absoluteSourceRoot = path.resolve(sourceRoot);
  const files = await walk(absoluteSourceRoot);

  const cases = [];

  for (const filePath of files) {
    let source = "";
    try {
      source = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const relative = path
      .relative(absoluteSourceRoot, filePath)
      .replace(/\\/g, "/");

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      continue;
    }

    collectCasesFromJsonNode(parsed, relative, cases);
  }

  const filtered = applyIndexFilters(
    cases,
    start,
    endExclusive,
    indexes,
    ranges,
  );
  const limited = limit > 0 ? filtered.slice(0, limit) : filtered;

  for (let index = 0; index < limited.length; index += 1) {
    limited[index] = {
      ...limited[index],
      outputIndex: index,
    };
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(limited, null, 2)}\n`, "utf8");

  console.log(
    `Generated ${limited.length} compatibility case(s) from ${cases.length} extracted raw case(s).`,
  );
  console.log(`Output: ${outPath}`);
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
