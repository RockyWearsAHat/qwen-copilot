#!/usr/bin/env node

import { spawn } from 'node:child_process';

const PORT = 11439;
const BASE = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await wait(150);
  }

  throw new Error('Proxy health check timed out');
}

async function assertModelsEndpoint() {
  const response = await fetch(`${BASE}/v1/models`);
  if (!response.ok) {
    throw new Error(`/v1/models failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (!Array.isArray(json?.data)) {
    throw new Error('/v1/models did not return an OpenAI models list');
  }

  if (json.data.length === 0) {
    throw new Error('/v1/models returned zero models');
  }

  console.log(`[test] /v1/models ok (count=${json.data.length})`);
  return json.data[0]?.id;
}

async function assertChatCompletions(model) {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: 'HELLO from proxy test' }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`/v1/chat/completions failed: ${response.status} ${response.statusText} ${text}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('/v1/chat/completions did not return a valid assistant message');
  }

  console.log(`[test] /v1/chat/completions ok (contentChars=${content.length})`);
}

async function main() {
  const child = spawn('node', ['scripts/ollama-openai-proxy.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[proxy] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[proxy-err] ${chunk}`);
  });

  try {
    await waitForHealth();
    const model = await assertModelsEndpoint();
    await assertChatCompletions(model);
    console.log('[test] PASS proxy integration');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[test] FAIL ${message}`);
  process.exit(1);
});
