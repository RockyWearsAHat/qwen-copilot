#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function runCommand(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`),
      );
    });
  });
}

async function main() {
  const corpusPath = process.env.LOCAL_QWEN_COPILOT_COMPAT_CASES
    ? path.resolve(process.env.LOCAL_QWEN_COPILOT_COMPAT_CASES)
    : path.resolve(
        process.cwd(),
        "test/fixtures/copilot-compat-cases.generated.json",
      );

  const batchSize = Math.max(
    1,
    toInt(process.env.LOCAL_QWEN_COPILOT_COMPAT_BATCH_SIZE, 200),
  );
  const totalLimit = Math.max(
    0,
    toInt(process.env.LOCAL_QWEN_COPILOT_COMPAT_TOTAL_LIMIT, 0),
  );
  const startIndex = Math.max(
    0,
    toInt(process.env.LOCAL_QWEN_COPILOT_COMPAT_START_INDEX, 0),
  );
  const minPassRate =
    process.env.LOCAL_QWEN_COPILOT_COMPAT_MIN_PASS_RATE ?? "1";
  const progressEvery =
    process.env.LOCAL_QWEN_COPILOT_COMPAT_PROGRESS_EVERY ?? "25";
  const indexes = process.env.LOCAL_QWEN_COPILOT_COMPAT_INDEXES ?? "";
  const ranges =
    process.env.LOCAL_QWEN_COPILOT_COMPAT_RANGES ??
    process.env.LOCAL_QWEN_COPILOT_COMPAT_RANGE ??
    "";
  const endIndexExclusive =
    process.env.LOCAL_QWEN_COPILOT_COMPAT_END_INDEX_EXCLUSIVE ?? "";
  const includeAllTests =
    process.env.LOCAL_QWEN_COPILOT_COMPAT_INCLUDE_ALL_TESTS === "1";

  const raw = await fs.readFile(corpusPath, "utf8");
  const parsed = JSON.parse(raw);
  const total = Array.isArray(parsed) ? parsed.length : 0;
  if (total <= 0) {
    throw new Error(`No cases found in ${corpusPath}`);
  }

  const cappedTotal = totalLimit > 0 ? Math.min(total, totalLimit) : total;
  const effectiveStart = Math.min(startIndex, cappedTotal);

  await runCommand("npm", ["run", "compile:test"], {
    ...process.env,
  });

  console.log(
    `[copilot-compat-full] total cases: ${cappedTotal}/${total}, start: ${effectiveStart}, batch size: ${batchSize}`,
  );

  for (let start = effectiveStart; start < cappedTotal; start += batchSize) {
    const size = Math.min(batchSize, cappedTotal - start);
    console.log(`[copilot-compat-full] batch start=${start} size=${size}`);

    const env = {
      ...process.env,
      LOCAL_QWEN_COPILOT_COMPAT: "1",
      LOCAL_QWEN_COPILOT_COMPAT_CASES: corpusPath,
      LOCAL_QWEN_COPILOT_COMPAT_START_INDEX: String(start),
      LOCAL_QWEN_COPILOT_COMPAT_MAX_CASES: String(size),
      LOCAL_QWEN_COPILOT_COMPAT_MIN_PASS_RATE: String(minPassRate),
      LOCAL_QWEN_COPILOT_COMPAT_DISABLE_TIMEOUT: "1",
      LOCAL_QWEN_COPILOT_COMPAT_PROGRESS_EVERY: String(progressEvery),
      ...(indexes ? { LOCAL_QWEN_COPILOT_COMPAT_INDEXES: indexes } : {}),
      ...(ranges ? { LOCAL_QWEN_COPILOT_COMPAT_RANGES: ranges } : {}),
      ...(endIndexExclusive
        ? {
            LOCAL_QWEN_COPILOT_COMPAT_END_INDEX_EXCLUSIVE: endIndexExclusive,
          }
        : {}),
    };

    if (includeAllTests) {
      await runCommand("node", ["./dist-test/test/runExtensionTests.js"], {
        ...env,
        LOCAL_QWEN_TEST_GLOB: process.env.LOCAL_QWEN_TEST_GLOB,
      });
      continue;
    }

    await runCommand(
      "node",
      [
        "./node_modules/mocha/bin/mocha.js",
        "./dist-test/test/suite/copilotCompatibilityCorpus.test.js",
        "--ui",
        "tdd",
        "--color",
        "--timeout",
        "0",
      ],
      env,
    );
  }

  console.log("[copilot-compat-full] all batches passed");
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
