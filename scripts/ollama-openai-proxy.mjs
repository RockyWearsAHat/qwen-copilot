#!/usr/bin/env node

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 11435);
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL || 'gemma4:e4b';
const FORCE_THINK_FALSE = (process.env.OLLAMA_FORCE_THINK_FALSE || 'true').toLowerCase() !== 'false';

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf8')
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function toOllamaMessages(openaiMessages) {
  if (!Array.isArray(openaiMessages)) {
    return [];
  }

  return openaiMessages.map((message) => {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    const content = normalizeContent(message?.content);
    return { role, content };
  });
}

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('');
  }

  return '';
}

function toOpenAiToolCalls(ollamaToolCalls) {
  if (!Array.isArray(ollamaToolCalls)) {
    return undefined;
  }

  const mapped = ollamaToolCalls
    .map((call) => {
      const name = call?.function?.name;
      if (!name) {
        return undefined;
      }

      let args = call?.function?.arguments;
      if (args === undefined || args === null) {
        args = {};
      }

      const argsText = typeof args === 'string' ? args : JSON.stringify(args);

      return {
        id: `call_${randomUUID().replace(/-/g, '')}`,
        type: 'function',
        function: {
          name,
          arguments: argsText
        }
      };
    })
    .filter(Boolean);

  return mapped.length > 0 ? mapped : undefined;
}

function toOpenAiUsage(ollamaJson) {
  const prompt = Number.isFinite(ollamaJson?.prompt_eval_count) ? ollamaJson.prompt_eval_count : 0;
  const completion = Number.isFinite(ollamaJson?.eval_count) ? ollamaJson.eval_count : 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion
  };
}

async function fetchModels() {
  const response = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`/api/tags failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const models = Array.isArray(json?.models) ? json.models : [];

  return models
    .map((model) => ({
      id: model?.name,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'ollama'
    }))
    .filter((model) => typeof model.id === 'string' && model.id.length > 0);
}

async function handleModels(_req, res) {
  const models = await fetchModels();
  sendJson(res, 200, {
    object: 'list',
    data: models
  });
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const model = typeof body?.model === 'string' && body.model.length > 0 ? body.model : DEFAULT_MODEL;
  const stream = Boolean(body?.stream);

  if (stream) {
    sendJson(res, 400, {
      error: {
        message: 'Streaming is not supported by this proxy. Set stream=false.',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  const ollamaPayload = {
    model,
    messages: toOllamaMessages(body?.messages),
    tools: Array.isArray(body?.tools) ? body.tools : undefined,
    stream: false,
    keep_alive: '30m',
    think: FORCE_THINK_FALSE ? false : undefined
  };

  const ollamaResponse = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaPayload)
  });

  const responseText = await ollamaResponse.text();
  if (!ollamaResponse.ok) {
    sendJson(res, 502, {
      error: {
        message: responseText || `Ollama error: ${ollamaResponse.status} ${ollamaResponse.statusText}`,
        type: 'api_error'
      }
    });
    return;
  }

  let ollamaJson;
  try {
    ollamaJson = JSON.parse(responseText);
  } catch {
    sendJson(res, 502, {
      error: {
        message: 'Ollama returned invalid JSON',
        type: 'api_error'
      }
    });
    return;
  }

  const content = typeof ollamaJson?.message?.content === 'string' ? ollamaJson.message.content : '';
  const toolCalls = toOpenAiToolCalls(ollamaJson?.message?.tool_calls);

  sendJson(res, 200, {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          tool_calls: toolCalls
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }
    ],
    usage: toOpenAiUsage(ollamaJson)
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, provider: 'ollama-openai-proxy' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      await handleModels(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChatCompletions(req, res);
      return;
    }

    sendJson(res, 404, {
      error: {
        message: `Route not found: ${req.method} ${url.pathname}`,
        type: 'invalid_request_error'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: {
        message,
        type: 'server_error'
      }
    });
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[proxy] upstream ollama: ${OLLAMA_BASE}`);
});
