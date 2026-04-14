#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const extensionPath = path.join(repoRoot, 'src', 'extension.ts');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function findInstalledCopilotChatManifests() {
  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions')
  ];

  const manifests = [];
  for (const root of roots) {
    if (!fileExists(root)) {
      continue;
    }

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('github.copilot-chat-')) {
        continue;
      }

      const manifestPath = path.join(root, entry.name, 'package.json');
      if (fileExists(manifestPath)) {
        manifests.push(manifestPath);
      }
    }
  }

  return manifests;
}

function getChatSessionTypes(manifestJson) {
  const sessions = manifestJson?.contributes?.chatSessions;
  if (!Array.isArray(sessions)) {
    return [];
  }

  return sessions
    .map((item) => item?.type)
    .filter((value) => typeof value === 'string' && value.length > 0);
}

function checkProviderManifest() {
  if (!fileExists(packageJsonPath)) {
    return { ok: false, detail: 'package.json not found' };
  }

  const pkg = readJson(packageJsonPath);
  const providers = pkg?.contributes?.languageModelChatProviders;
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, detail: 'contributes.languageModelChatProviders missing or empty' };
  }

  const hasLocalVendor = providers.some((p) => p?.vendor === 'local');
  return {
    ok: hasLocalVendor,
    detail: hasLocalVendor
      ? 'languageModelChatProviders contains vendor=local'
      : 'languageModelChatProviders present but vendor=local not found'
  };
}

function checkProviderCodeHints() {
  if (!fileExists(extensionPath)) {
    return { ok: false, detail: 'src/extension.ts not found' };
  }

  const source = fs.readFileSync(extensionPath, 'utf8');
  const checks = [
    {
      key: 'targetChatSessionType',
      pattern: /targetChatSessionType\s*:\s*OLLAMA_TARGET_CHAT_SESSION_TYPE/
    },
    {
      key: 'requestInitiatorLogging',
      pattern: /requestInitiator\s*:\s*options\.requestInitiator/
    },
    {
      key: 'toolCallingCapability',
      pattern: /toolCalling\s*:\s*true/
    }
  ];

  const failed = checks.filter((item) => !item.pattern.test(source)).map((item) => item.key);
  return {
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'provider code hints are present' : `missing hints: ${failed.join(', ')}`
  };
}

function checkCopilotSessionSupport() {
  const manifestPaths = findInstalledCopilotChatManifests();
  if (manifestPaths.length === 0) {
    return {
      ok: false,
      detail: 'No installed github.copilot-chat manifests found in ~/.vscode or ~/.vscode-insiders',
      discoveredSessionTypes: []
    };
  }

  const sessionTypes = new Set();
  const copilotCliSessions = [];
  for (const manifestPath of manifestPaths) {
    const manifest = readJson(manifestPath);
    for (const type of getChatSessionTypes(manifest)) {
      sessionTypes.add(type);
    }

    const sessions = manifest?.contributes?.chatSessions;
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        if (session?.type === 'copilotcli') {
          copilotCliSessions.push({
            manifestPath,
            customAgentTarget: session.customAgentTarget,
            requiresCustomModels: Boolean(session.requiresCustomModels)
          });
        }
      }
    }
  }

  const discoveredSessionTypes = [...sessionTypes].sort();
  const hasCopilotCli = discoveredSessionTypes.includes('copilotcli');
  const hasCopilotManagedTarget = copilotCliSessions.some(
    (session) => session.customAgentTarget === 'github-copilot' && session.requiresCustomModels
  );

  return {
    ok: hasCopilotCli,
    detail: hasCopilotCli
      ? 'installed Copilot manifests include chatSessions type=copilotcli'
      : 'installed Copilot manifests do not expose chatSessions type=copilotcli',
    discoveredSessionTypes,
    copilotCliSessions,
    hasCopilotManagedTarget
  };
}

function printCheck(name, result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`${status} ${name}: ${result.detail}`);
}

function main() {
  console.log('=== CLI Surfacing Validation ===');

  const providerManifest = checkProviderManifest();
  const providerCode = checkProviderCodeHints();
  const copilotSessions = checkCopilotSessionSupport();

  printCheck('Provider manifest', providerManifest);
  printCheck('Provider code hints', providerCode);
  printCheck('Installed Copilot session support', copilotSessions);

  if (copilotSessions.discoveredSessionTypes) {
    console.log(`Discovered chat session types: ${copilotSessions.discoveredSessionTypes.join(', ') || 'none'}`);
  }

  if (copilotSessions.copilotCliSessions?.length) {
    for (const session of copilotSessions.copilotCliSessions) {
      console.log(
        `copilotcli session: customAgentTarget=${String(session.customAgentTarget)} requiresCustomModels=${String(session.requiresCustomModels)} source=${session.manifestPath}`
      );
    }
  }

  const allPass = providerManifest.ok && providerCode.ok && copilotSessions.ok;
  if (copilotSessions.hasCopilotManagedTarget) {
    console.log('RESULT: BLOCKED-BY-COPILOT-CLI-ROUTING-POLICY');
    process.exit(2);
  }

  console.log(allPass ? 'RESULT: READY-FOR-CLI-SURFACING-TEST' : 'RESULT: BLOCKED-BY-SURFACING-PREREQS');
  process.exit(allPass ? 0 : 1);
}

main();
