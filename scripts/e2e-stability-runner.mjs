import { spawnSync } from "node:child_process";

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const rounds = Math.max(
  1,
  Math.floor(toNumber(process.env.LOCAL_QWEN_E2E_ROUNDS, 5)),
);
const minPassRate = Math.min(
  1,
  Math.max(0, toNumber(process.env.LOCAL_QWEN_E2E_MIN_PASS_RATE, 1)),
);

const baseEnv = {
  ...process.env,
  LOCAL_QWEN_E2E: "1",
};

const runDurationsMs = [];
let passedRuns = 0;
let failedRuns = 0;

console.log(
  `[e2e-stability] starting ${rounds} run(s), required pass rate=${(minPassRate * 100).toFixed(1)}%`,
);

for (let run = 1; run <= rounds; run += 1) {
  const startedAt = Date.now();
  console.log(`[e2e-stability] run ${run}/${rounds} starting...`);

  const result = spawnSync("npm", ["run", "test:extension"], {
    env: baseEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const elapsedMs = Date.now() - startedAt;
  runDurationsMs.push(elapsedMs);

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const isPass = result.status === 0;

  if (isPass) {
    passedRuns += 1;
    console.log(`[e2e-stability] run ${run} PASS (${elapsedMs}ms)`);
  } else {
    failedRuns += 1;
    console.log(`[e2e-stability] run ${run} FAIL (${elapsedMs}ms)`);
    console.log("[e2e-stability] failure output excerpt:");
    const lines = output
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-40);
    for (const line of lines) {
      console.log(line);
    }
  }
}

const passRate = passedRuns / rounds;
const averageMs =
  runDurationsMs.reduce((sum, value) => sum + value, 0) / runDurationsMs.length;
const sorted = [...runDurationsMs].sort((left, right) => left - right);
const medianMs = sorted[Math.floor(sorted.length / 2)];
const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
const p95Ms = sorted[p95Index];

console.log("[e2e-stability] summary:");
console.log(`  passed=${passedRuns}`);
console.log(`  failed=${failedRuns}`);
console.log(`  passRate=${(passRate * 100).toFixed(1)}%`);
console.log(`  avgMs=${Math.round(averageMs)}`);
console.log(`  medianMs=${medianMs}`);
console.log(`  p95Ms=${p95Ms}`);

if (passRate < minPassRate) {
  console.error(
    `[e2e-stability] FAIL: pass rate ${(passRate * 100).toFixed(1)}% is below threshold ${(minPassRate * 100).toFixed(1)}%.`,
  );
  process.exit(1);
}

console.log("[e2e-stability] PASS: stability threshold satisfied.");
