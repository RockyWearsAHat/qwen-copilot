const assert = require("node:assert/strict");
const { OllamaClient } = require("../dist/llm/ollamaClient.js");

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractFirstJsonObject(text) {
  const trimmed = (text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [trimmed, fenced?.[1] ?? ""];

  for (const candidate of candidates) {
    const source = candidate.trim();
    if (!source) continue;

    try {
      const direct = JSON.parse(source);
      if (direct && typeof direct === "object" && !Array.isArray(direct)) {
        return direct;
      }
    } catch {}

    const objectMatch = source.match(/\{[\s\S]*\}/);
    if (!objectMatch) continue;

    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }

  return undefined;
}

function normalizeFragment(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function computeRepetitionEvents(transcript) {
  const source = String(transcript || "").trim();
  if (!source) {
    return 0;
  }

  const fragments = source
    .split(/[\n.!?]+/g)
    .map(normalizeFragment)
    .filter((fragment) => fragment.length >= 18);

  if (fragments.length === 0) {
    return 0;
  }

  const counts = new Map();
  for (const fragment of fragments) {
    counts.set(fragment, (counts.get(fragment) || 0) + 1);
  }

  let duplicateEvents = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      duplicateEvents += count - 1;
    }
  }

  return duplicateEvents;
}

function detectContextDrift(transcript) {
  const text = normalizeFragment(transcript);
  if (!text) {
    return true;
  }

  const oppositeRewrite =
    /(instead of|replace)\s+\/?level1\.json\s+(with|use)\s+\/?assets\/level1\.json/i.test(
      text,
    ) ||
    /(instead of|replace)\s+level1\.json\s+(with|use)\s+assets\/level1\.json/i.test(
      text,
    );

  if (oppositeRewrite) {
    return true;
  }

  const hasTarget = /\/?level1\.json/.test(text);
  const hasSource = /\/?assets\/level1\.json/.test(text);
  const hasReplacementAction =
    /replace_in_files|replace_string_in_file|multi_replace_string_in_file/.test(
      text,
    ) || /instead of/.test(text);

  if (hasReplacementAction && (!hasSource || !hasTarget)) {
    return true;
  }

  return false;
}

function detectIntentSignal(transcript) {
  const text = normalizeFragment(transcript);
  if (!text) {
    return false;
  }

  const hasSource = /\/?assets\/level1\.json/.test(text);
  const hasTarget = /\/?level1\.json/.test(text);
  const hasReplaceTool =
    /replace_in_files|replace_string_in_file|multi_replace_string_in_file/.test(
      text,
    );
  const hasIntentPhrase =
    /instead of\s+\/?assets\/level1\.json\s*,?\s*use\s+\/?level1\.json/.test(
      text,
    ) ||
    /replace\s+\/?assets\/level1\.json\s+with\s+\/?level1\.json/.test(text);

  return (
    (hasSource && hasTarget) || (hasTarget && hasReplaceTool) || hasIntentPhrase
  );
}

function toNotesText(score) {
  const raw = score?.notes;
  if (Array.isArray(raw)) {
    return normalizeFragment(raw.join(" "));
  }
  if (typeof raw === "string") {
    return normalizeFragment(raw);
  }
  return "";
}

function detectIntentSignalFromScore(score, minRequestAlignment) {
  const verdict = String(score?.verdict || "").toLowerCase();
  const alignment = toNumber(score?.requestAlignment, 0);
  const notesText = toNotesText(score);
  const mentionsSource = /\/?assets\/level1\.json/.test(notesText);
  const mentionsTarget = /\/?level1\.json/.test(notesText);
  const mentionsMappingPhrase =
    /instead of\s+\/?assets\/level1\.json\s*,?\s*use\s+\/?level1\.json/.test(
      notesText,
    ) ||
    /replace\s+\/?assets\/level1\.json\s+with\s+\/?level1\.json/.test(
      notesText,
    );
  const mentionsGenericMapping =
    /replacement mapping|file path replacement mapping|path replacement mapping|from\/?to mapping/.test(
      notesText,
    );

  return (
    verdict === "good" &&
    alignment >= minRequestAlignment &&
    ((mentionsSource && mentionsTarget) ||
      mentionsMappingPhrase ||
      mentionsGenericMapping)
  );
}

async function streamConversation(
  client,
  endpoint,
  model,
  messages,
  tools,
  temperature = 0.2,
) {
  const startedAt = Date.now();
  let firstTokenMs = -1;
  let text = "";
  let toolCalls = 0;
  const toolCallLines = [];

  const response = await client.chatStream(
    {
      endpoint,
      model,
      messages,
      tools,
      temperature,
      maxOutputTokens: 1800,
      contextWindowTokens: 32768,
    },
    new AbortController().signal,
    0,
  );

  for await (const chunk of response.stream) {
    const delta = chunk.message.content || "";
    if (delta.length > 0 && firstTokenMs < 0) {
      firstTokenMs = Date.now() - startedAt;
    }
    text += delta;

    if (Array.isArray(chunk.message.tool_calls)) {
      if (chunk.message.tool_calls.length > 0 && firstTokenMs < 0) {
        firstTokenMs = Date.now() - startedAt;
      }
      toolCalls += chunk.message.tool_calls.length;
      for (const call of chunk.message.tool_calls) {
        const args =
          typeof call.function.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function.arguments || {});
        toolCallLines.push(`${call.function.name}(${args})`);
      }
    }
  }

  const trimmed = text.trim();
  const transcript =
    trimmed.length > 0
      ? trimmed
      : toolCallLines.length > 0
        ? `Model emitted tool calls without prose:\n${toolCallLines.join("\n")}`
        : "";

  return {
    elapsedMs: Date.now() - startedAt,
    firstTokenMs,
    toolCalls,
    transcript,
  };
}

async function scoreConversation(
  client,
  endpoint,
  graderModel,
  userRequest,
  transcript,
) {
  const prompt = [
    "You are grading a coding assistant response.",
    "Give a strict 0-10 score for:",
    "repetitiveness (higher=less repetitive), requestAlignment, stepEfficiency, readability, simplicity, overall.",
    "Return JSON only with keys: repetitiveness, requestAlignment, stepEfficiency, readability, simplicity, overall, verdict, notes.",
    "verdict must be good or bad.",
    `User request: ${userRequest}`,
    "Transcript:",
    transcript,
  ].join("\n");

  const result = await client.chat(
    {
      endpoint,
      model: graderModel,
      temperature: 0,
      tools: [],
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: 600,
      contextWindowTokens: 8192,
    },
    new AbortController().signal,
    0,
  );

  const raw = result.message.content || "";
  const parsed = extractFirstJsonObject(raw);
  assert.ok(parsed, `unable to parse grader JSON: ${raw.slice(0, 600)}`);
  return parsed;
}

async function run() {
  const endpoint =
    process.env.LOCAL_QWEN_E2E_ENDPOINT || "http://localhost:11434";
  const model = process.env.LOCAL_QWEN_E2E_MODEL || "qwen3-coder:30b-256k";
  const graderModel = process.env.LOCAL_QWEN_E2E_GRADER_MODEL || model;
  const rounds = Math.max(
    1,
    Math.floor(toNumber(process.env.LOCAL_QWEN_PROBE_ROUNDS, 3)),
  );
  const minIntentSignalRate = Math.min(
    1,
    Math.max(
      0,
      toNumber(process.env.LOCAL_QWEN_PROBE_MIN_INTENT_SIGNAL_RATE, 1),
    ),
  );
  const minGoodVerdictRate = Math.min(
    1,
    Math.max(
      0,
      toNumber(process.env.LOCAL_QWEN_PROBE_MIN_GOOD_VERDICT_RATE, 1),
    ),
  );
  const minRequestAlignment = Math.max(
    0,
    Math.min(
      10,
      toNumber(process.env.LOCAL_QWEN_PROBE_MIN_REQUEST_ALIGNMENT, 8),
    ),
  );
  const minStepEfficiency = Math.max(
    0,
    Math.min(10, toNumber(process.env.LOCAL_QWEN_PROBE_MIN_STEP_EFFICIENCY, 9)),
  );
  const maxRepetitionEvents = Math.max(
    0,
    Math.floor(toNumber(process.env.LOCAL_QWEN_PROBE_MAX_REPETITION_EVENTS, 2)),
  );
  const maxDriftRate = Math.min(
    1,
    Math.max(
      0,
      toNumber(process.env.LOCAL_QWEN_PROBE_MAX_CONTEXT_DRIFT_RATE, 0),
    ),
  );
  const minRequestAlignmentRate = Math.min(
    1,
    Math.max(
      0,
      toNumber(process.env.LOCAL_QWEN_PROBE_MIN_REQUEST_ALIGNMENT_RATE, 1),
    ),
  );

  const isolatedWorkspace = "/tmp/local-qwen-intent-probe-env";
  const userGoal =
    "Instead of /assets/level1.json, use /level1.json everywhere in the project. Keep this exact goal persistent for the whole request.";

  const tools = [
    {
      type: "function",
      function: {
        name: "create_new_workspace",
        description: "Create a new project workspace in VS Code.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read file contents.",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
          required: ["filePath", "startLine", "endLine"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep_search",
        description: "Search file contents.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            isRegexp: { type: "boolean" },
          },
          required: ["query", "isRegexp"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "replace_in_files",
        description: "Replace text across files in one operation.",
        parameters: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
    },
  ];

  const churnMessages = [
    {
      role: "assistant",
      content: "Running read_file and grep_search for impact scope.",
    },
    {
      role: "user",
      content:
        "Tool result noise: searched folders, found many unrelated files.",
    },
    {
      role: "assistant",
      content: "Scope checked. Next step is one workspace-wide replacement.",
    },
    {
      role: "user",
      content: "Correction: do not drift. Keep original replacement goal.",
    },
    {
      role: "assistant",
      content: "Proceeding with the same replacement goal, no drift.",
    },
    {
      role: "user",
      content: "More tool noise: 50 lines from source, no direct edits yet.",
    },
    {
      role: "assistant",
      content: "Using replace_in_files for the global replacement.",
    },
    {
      role: "user",
      content:
        "That per-file replacement failed. Continue with the SAME global goal.",
    },
  ];

  const client = new OllamaClient();
  const outcomes = [];

  for (let round = 1; round <= rounds; round += 1) {
    const userRequest = [
      `Round ${round}: start a new vite project in ${isolatedWorkspace}.`,
      userGoal,
      "Do not drift from the replacement mapping (/assets/level1.json -> /level1.json).",
      "Avoid repetitive narration. Keep progress updates minimal.",
      "Prioritize high step efficiency: complete in as few actions as possible.",
      "In your final response, restate the exact mapping once.",
    ].join(" ");

    const messages = [
      {
        role: "system",
        content:
          "You are a coding agent. Persist the user replacement goal exactly across tool churn and corrections. Never invert or rewrite the from/to mapping.",
      },
      { role: "user", content: userGoal },
      ...churnMessages,
      { role: "user", content: userRequest },
    ];

    const stream = await streamConversation(
      client,
      endpoint,
      model,
      messages,
      tools,
      0.2,
    );
    const score = await scoreConversation(
      client,
      endpoint,
      graderModel,
      userRequest,
      stream.transcript,
    );

    const transcriptLower = (stream.transcript || "").toLowerCase();
    const transcriptIntentSignal = detectIntentSignal(transcriptLower);
    const graderIntentSignal = detectIntentSignalFromScore(
      score,
      minRequestAlignment,
    );
    const hasIntentSignal = transcriptIntentSignal || graderIntentSignal;
    const repetitionEvents = computeRepetitionEvents(stream.transcript);
    const drifted = detectContextDrift(stream.transcript);
    const stepEfficiency = toNumber(score?.stepEfficiency, 0);

    outcomes.push({
      round,
      elapsedMs: stream.elapsedMs,
      firstTokenMs: stream.firstTokenMs,
      toolCalls: stream.toolCalls,
      hasIntentSignal,
      transcriptIntentSignal,
      graderIntentSignal,
      repetitionEvents,
      drifted,
      stepEfficiency,
      score,
      transcript: stream.transcript,
    });
  }

  console.log("\n=== E2E Intent Probe Results ===");
  for (const result of outcomes) {
    console.log(`\n[Round ${result.round}]`);
    console.log(
      `firstTokenMs=${result.firstTokenMs} elapsedMs=${result.elapsedMs} toolCalls=${result.toolCalls}`,
    );
    console.log(
      `intentSignal=${result.hasIntentSignal} (transcript=${result.transcriptIntentSignal}, grader=${result.graderIntentSignal}) repetitionEvents=${result.repetitionEvents} drifted=${result.drifted} stepEfficiency=${result.stepEfficiency}`,
    );
    console.log(`score=${JSON.stringify(result.score)}`);
    console.log("transcriptExcerpt:");
    console.log((result.transcript || "").slice(0, 900));
  }

  const intentSignalRate =
    outcomes.filter((item) => item.hasIntentSignal).length / outcomes.length;
  const goodVerdictRate =
    outcomes.filter(
      (item) => String(item.score?.verdict || "").toLowerCase() === "good",
    ).length / outcomes.length;
  const requestAlignmentRate =
    outcomes.filter(
      (item) =>
        Number(item.score?.requestAlignment ?? 0) >= minRequestAlignment,
    ).length / outcomes.length;
  const stepEfficiencyRate =
    outcomes.filter((item) => item.stepEfficiency >= minStepEfficiency).length /
    outcomes.length;
  const repetitionPassRate =
    outcomes.filter((item) => item.repetitionEvents <= maxRepetitionEvents)
      .length / outcomes.length;
  const contextDriftRate =
    outcomes.filter((item) => item.drifted).length / outcomes.length;

  console.log("\n=== Summary ===");
  console.log(`rounds=${outcomes.length}`);
  console.log(`intentSignalRate=${(intentSignalRate * 100).toFixed(1)}%`);
  console.log(`goodVerdictRate=${(goodVerdictRate * 100).toFixed(1)}%`);
  console.log(
    `requestAlignment>=${minRequestAlignment}: ${(requestAlignmentRate * 100).toFixed(1)}%`,
  );
  console.log(
    `stepEfficiency>=${minStepEfficiency}: ${(stepEfficiencyRate * 100).toFixed(1)}%`,
  );
  console.log(
    `repetitionEvents<=${maxRepetitionEvents}: ${(repetitionPassRate * 100).toFixed(1)}%`,
  );
  console.log(`contextDriftRate=${(contextDriftRate * 100).toFixed(1)}%`);

  const failures = [];
  if (intentSignalRate < minIntentSignalRate) {
    failures.push(
      `intentSignalRate ${(intentSignalRate * 100).toFixed(1)}% < ${(minIntentSignalRate * 100).toFixed(1)}%`,
    );
  }
  if (goodVerdictRate < minGoodVerdictRate) {
    failures.push(
      `goodVerdictRate ${(goodVerdictRate * 100).toFixed(1)}% < ${(minGoodVerdictRate * 100).toFixed(1)}%`,
    );
  }
  if (requestAlignmentRate < minRequestAlignmentRate) {
    failures.push(
      `requestAlignment>=${minRequestAlignment} rate ${(requestAlignmentRate * 100).toFixed(1)}% < ${(minRequestAlignmentRate * 100).toFixed(1)}%`,
    );
  }
  if (stepEfficiencyRate < 1) {
    failures.push(
      `stepEfficiency>=${minStepEfficiency} rate ${(stepEfficiencyRate * 100).toFixed(1)}% < 100.0%`,
    );
  }
  if (repetitionPassRate < 1) {
    failures.push(
      `repetitionEvents<=${maxRepetitionEvents} rate ${(repetitionPassRate * 100).toFixed(1)}% < 100.0%`,
    );
  }
  if (contextDriftRate > maxDriftRate) {
    failures.push(
      `contextDriftRate ${(contextDriftRate * 100).toFixed(1)}% > ${(maxDriftRate * 100).toFixed(1)}%`,
    );
  }

  if (failures.length > 0) {
    console.error("\n=== Probe Gate FAIL ===");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("\n=== Probe Gate PASS ===");
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
