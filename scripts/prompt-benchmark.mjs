import fs from "node:fs";

const endpoint = "http://localhost:11434/api/chat";
const model = "qwen3-coder:30b-256k";

const lines = fs
  .readFileSync("request.json", "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);

const first = JSON.parse(lines[0]);
const messages = first.request.messages;

const heavyPrompt = messages
  .map((message, index) => `[${message.role.toUpperCase()}#${index + 1}]\n${message.content}`)
  .join("\n\n");

const compactPrompt = messages[2]?.content ?? "";

const minimalPrompt = [
  "Vite app fails to load an image asset.",
  "Observed browser error target img src=http://localhost:3000/PNG/explosion.png",
  "Given Vite publicDir=assets, identify root cause and exact code fix in src/platformerGame.ts.",
  "Keep answer concise and specific.",
].join("\n");

function grade(text) {
  const lower = text.toLowerCase();
  let score = 0;

  if (lower.includes("explosion") || lower.includes("/png/explosion.png")) {
    score += 1;
  }

  if (
    lower.includes("missing") ||
    lower.includes("not found") ||
    lower.includes("404") ||
    lower.includes("does not exist")
  ) {
    score += 1;
  }

  if (
    lower.includes("platformergame.ts") ||
    lower.includes("assets.explosion") ||
    lower.includes("change")
  ) {
    score += 1;
  }

  if (lower.includes("publicdir") || lower.includes("assets/") || lower.includes("/png/")) {
    score += 1;
  }

  return score;
}

async function runCase(name, prompt) {
  const body = {
    model,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    options: {
      temperature: 0.2,
      num_predict: 220,
    },
  };

  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const wallMs = Date.now() - startedAt;
  const content = data?.message?.content ?? "";

  console.log(`\n=== ${name} ===`);
  console.log(
    [
      `promptChars=${prompt.length}`,
      `wallMs=${wallMs}`,
      `totalDurationMs=${Math.round((data.total_duration ?? 0) / 1e6)}`,
      `promptEval=${data.prompt_eval_count ?? 0}`,
      `eval=${data.eval_count ?? 0}`,
      `accuracyScore=${grade(content)}/4`,
    ].join(" "),
  );
  console.log(`preview=${content.slice(0, 420).replace(/\n/g, " ")}`);
}

console.log(`model=${model}`);
console.log(
  `baselinePromptStats heavy=${heavyPrompt.length} compact=${compactPrompt.length} minimal=${minimalPrompt.length}`,
);

await runCase("HEAVY_FROM_LOG", heavyPrompt);
await runCase("COMPACT_ERROR_ONLY", compactPrompt);
await runCase("MINIMAL_TARGETED", minimalPrompt);
