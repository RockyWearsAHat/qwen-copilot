#!/usr/bin/env node

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const CHAT_URL = `${OLLAMA_BASE}/api/chat`;
const TAGS_URL = `${OLLAMA_BASE}/api/tags`;
const VERSION_URL = `${OLLAMA_BASE}/api/version`;

const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_DIAG_TIMEOUT_MS || 120000);

function nowMs() {
  return performance.now();
}

function summarizeError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function makeFakeTools(count) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i + 1}`,
      description: `Diagnostic tool ${i + 1} that performs a synthetic action for latency profiling.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Input query'
          }
        },
        required: ['query']
      }
    }
  }));
}

function makeLargeHistory() {
  const bigText = 'x'.repeat(1200);
  const messages = [];
  for (let i = 0; i < 24; i += 1) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `History ${i + 1}: ${bigText}`
    });
  }
  messages.push({ role: 'user', content: 'HELLO' });
  return messages;
}

async function getJsonWithTimeout(url, timeoutMs) {
  const started = nowMs();
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const elapsedMs = +(nowMs() - started).toFixed(1);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    ok: response.ok,
    status: response.status,
    elapsedMs,
    text,
    json
  };
}

async function runScenario(name, payload) {
  const payloadText = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
  const started = nowMs();

  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payloadText,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      name,
      ok: false,
      status: null,
      payloadBytes,
      fetchMs: +(nowMs() - started).toFixed(1),
      totalMs: +(nowMs() - started).toFixed(1),
      error: summarizeError(error)
    };
  }

  const fetchMs = +(nowMs() - started).toFixed(1);
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    return {
      name,
      ok: false,
      status: response.status,
      payloadBytes,
      fetchMs,
      totalMs: +(nowMs() - started).toFixed(1),
      error: `ReadError: ${summarizeError(error)}`
    };
  }

  const totalMs = +(nowMs() - started).toFixed(1);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  const content = json?.message?.content;
  const toolCalls = Array.isArray(json?.message?.tool_calls) ? json.message.tool_calls.length : 0;

  return {
    name,
    ok: response.ok,
    status: response.status,
    payloadBytes,
    fetchMs,
    totalMs,
    contentChars: typeof content === 'string' ? content.length : 0,
    toolCalls,
    hasThinking: typeof json?.message?.thinking === 'string' && json.message.thinking.length > 0,
    totalDurationNs: typeof json?.total_duration === 'number' ? json.total_duration : null,
    loadDurationNs: typeof json?.load_duration === 'number' ? json.load_duration : null,
    error: response.ok ? null : (json?.error || text.slice(0, 240))
  };
}

function printHeader(title) {
  console.log('');
  console.log(`=== ${title} ===`);
}

function printKeyValue(label, value) {
  console.log(`${label}: ${value}`);
}

function toSec(ns) {
  if (typeof ns !== 'number') {
    return 'n/a';
  }
  return (ns / 1e9).toFixed(3);
}

function printScenarioResult(result) {
  console.log('');
  console.log(`Scenario: ${result.name}`);
  console.log(`ok=${result.ok} status=${result.status} payloadBytes=${result.payloadBytes} fetchMs=${result.fetchMs} totalMs=${result.totalMs}`);
  if (result.error) {
    console.log(`error=${result.error}`);
    return;
  }
  console.log(`contentChars=${result.contentChars} toolCalls=${result.toolCalls} hasThinking=${result.hasThinking}`);
  console.log(`ollama.total_duration_s=${toSec(result.totalDurationNs)} ollama.load_duration_s=${toSec(result.loadDurationNs)}`);
}

async function main() {
  printHeader('Ollama Preflight');

  const version = await getJsonWithTimeout(VERSION_URL, 3000).catch((error) => ({
    ok: false,
    status: null,
    elapsedMs: 3000,
    text: '',
    json: undefined,
    error: summarizeError(error)
  }));

  if (!version.ok) {
    printKeyValue('version', `FAIL ${version.status ?? ''} ${version.error || version.text}`);
    process.exit(1);
  }

  printKeyValue('version', `PASS ${version.elapsedMs}ms ${(version.json && version.json.version) || 'unknown'}`);

  const tags = await getJsonWithTimeout(TAGS_URL, 5000).catch((error) => ({
    ok: false,
    status: null,
    elapsedMs: 5000,
    text: '',
    json: undefined,
    error: summarizeError(error)
  }));

  if (!tags.ok) {
    printKeyValue('tags', `FAIL ${tags.status ?? ''} ${tags.error || tags.text}`);
    process.exit(1);
  }

  const modelNames = Array.isArray(tags.json?.models)
    ? tags.json.models.map((m) => m?.name).filter((s) => typeof s === 'string')
    : [];

  printKeyValue('tags', `PASS ${tags.elapsedMs}ms models=${modelNames.join(', ') || 'none'}`);

  const model = modelNames.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : (modelNames[0] || DEFAULT_MODEL);
  printKeyValue('selectedModel', model);
  printKeyValue('timeoutMs', REQUEST_TIMEOUT_MS);

  printHeader('Scenario Matrix');

  const scenarios = [
    {
      name: 'minimal/no-tools/think-false/stream-false',
      payload: {
        model,
        messages: [{ role: 'user', content: 'HELLO' }],
        stream: false,
        think: false,
        keep_alive: '30m'
      }
    },
    {
      name: 'minimal/no-tools/default-think/stream-false',
      payload: {
        model,
        messages: [{ role: 'user', content: 'HELLO' }],
        stream: false,
        keep_alive: '30m'
      }
    },
    {
      name: 'minimal/no-tools/think-false/stream-true',
      payload: {
        model,
        messages: [{ role: 'user', content: 'HELLO' }],
        stream: true,
        think: false,
        keep_alive: '30m'
      }
    },
    {
      name: 'large-history/no-tools/think-false/stream-false',
      payload: {
        model,
        messages: makeLargeHistory(),
        stream: false,
        think: false,
        keep_alive: '30m'
      }
    },
    {
      name: 'minimal/30-tools/think-false/stream-false',
      payload: {
        model,
        messages: [{ role: 'user', content: 'HELLO' }],
        tools: makeFakeTools(30),
        stream: false,
        think: false,
        keep_alive: '30m'
      }
    }
  ];

  for (const scenario of scenarios) {
    // Run serially to keep model state predictable and timing meaningful.
    const result = await runScenario(scenario.name, scenario.payload);
    printScenarioResult(result);
  }

  printHeader('Done');
}

main().catch((error) => {
  console.error(`Fatal: ${summarizeError(error)}`);
  process.exit(1);
});
