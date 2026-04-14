import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [path.resolve(__dirname, "../../"), "--disable-extensions"],
    extensionTestsEnv: {
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
    },
  });
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error("Failed to run extension tests");
  console.error(message);
  process.exit(1);
});
