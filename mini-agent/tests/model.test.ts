/**
 * 模型适配层测试：用注入的 fetch 桩验证协议转换、错误归一化与超时，不走真实网络。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ModelError,
  OpenAICompatibleClient,
  createClientFromEnv,
  readEnvConfig,
} from '../src/model.js';
import type { Message } from '../src/types.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** 用桩函数替换 fetch，并记录请求 */
function makeFetch(handler: (request: CapturedRequest) => Response | Promise<Response>) {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), init: init ?? {} };
    captured.push(request);
    return handler(request);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const messages: Message[] = [{ role: 'user', content: '你好' }];

const baseOptions = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key-placeholder',
  model: 'test-model',
};

describe('OpenAICompatibleClient：请求构造', () => {
  it('请求 chat/completions，带 Bearer 头与工具声明', async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: '你好' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    const response = await client.chat(messages, [
      {
        name: 'echo',
        description: '回显',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);

    assert.equal(response.content, '你好');
    assert.deepEqual(response.toolCalls, []);
    assert.deepEqual(response.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });

    const request = captured[0]!;
    assert.equal(request.url, 'https://example.test/v1/chat/completions');
    assert.equal(request.init.method, 'POST');
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer test-key-placeholder');
    assert.equal(headers['content-type'], 'application/json');

    const body = JSON.parse(String(request.init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      tools?: Array<{ type: string; function: { name: string } }>;
    };
    assert.equal(body.model, 'test-model');
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
    assert.equal(body.tools?.[0]?.function.name, 'echo');
    assert.equal(body.tools?.[0]?.type, 'function');
  });

  it('没有工具时不发送 tools 字段', async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    await client.chat(messages);
    await client.chat(messages, []);

    const first = JSON.parse(String(captured[0]!.init.body)) as Record<string, unknown>;
    const second = JSON.parse(String(captured[1]!.init.body)) as Record<string, unknown>;
    assert.equal('tools' in first, false);
    assert.equal('tools' in second, false);
  });

  it('解析 tool_calls，缺失 id 时补占位 id', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { function: { name: 'calculator', arguments: '{"expression":"1+1"}' } },
                { id: 'call_x', type: 'function', function: { name: 'todo', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    );
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    const response = await client.chat(messages);

    assert.equal(response.content, '');
    assert.equal(response.toolCalls.length, 2);
    assert.equal(response.toolCalls[0]!.id, 'call_0');
    assert.equal(response.toolCalls[0]!.name, 'calculator');
    assert.equal(response.toolCalls[0]!.arguments, '{"expression":"1+1"}');
    assert.equal(response.toolCalls[1]!.id, 'call_x');
    assert.equal(response.usage, undefined);
  });

  it('baseUrl 带尾斜杠或已是完整 endpoint 都能正确拼接', async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

    await new OpenAICompatibleClient({ ...baseOptions, baseUrl: 'https://example.test/v1/', fetchImpl }).chat(
      messages,
    );
    await new OpenAICompatibleClient({
      ...baseOptions,
      baseUrl: 'https://example.test/v1/chat/completions',
      fetchImpl,
    }).chat(messages);

    assert.equal(captured[0]!.url, 'https://example.test/v1/chat/completions');
    assert.equal(captured[1]!.url, 'https://example.test/v1/chat/completions');
  });
});

describe('OpenAICompatibleClient：错误处理', () => {
  it('非 2xx 抛带状态码的 ModelError，并抽取服务端错误信息', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    await assert.rejects(
      () => client.chat(messages),
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, 401);
        assert.match(error.message, /HTTP 401/);
        assert.equal(error.detail, 'invalid api key');
        return true;
      },
    );
  });

  it('429 响应带 Retry-After 时，ModelError 暴露 retryAfterMs', async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        }),
    );
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    await assert.rejects(
      () => client.chat(messages),
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 2000);
        return true;
      },
    );
  });

  it('响应体不是 JSON 时抛 ModelError', async () => {
    const { fetchImpl } = makeFetch(() => new Response('<html>bad gateway</html>', { status: 200 }));
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    await assert.rejects(() => client.chat(messages), /不是合法 JSON/);
  });

  it('缺少 choices 时抛 ModelError', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    await assert.rejects(() => client.chat(messages), /choices\[0\]\.message/);
  });

  it('网络异常归一化为 ModelError（status=0）', async () => {
    const { fetchImpl } = makeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = new OpenAICompatibleClient({ ...baseOptions, fetchImpl });

    await assert.rejects(
      () => client.chat(messages),
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, 0);
        assert.match(error.message, /网络错误/);
        return true;
      },
    );
  });

  it('超时会被 AbortController 中断并抛 ModelError', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const client = new OpenAICompatibleClient({ ...baseOptions, timeoutMs: 20, fetchImpl });

    await assert.rejects(() => client.chat(messages), /超时（20ms）/);
  });

  it('构造时缺少凭据直接抛错，且错误信息不回显 key', () => {
    assert.throws(() => new OpenAICompatibleClient({ ...baseOptions, apiKey: '' }), /apiKey/);
    assert.throws(() => new OpenAICompatibleClient({ ...baseOptions, baseUrl: '' }), /baseUrl/);
    assert.throws(() => new OpenAICompatibleClient({ ...baseOptions, model: '' }), /model/);
  });
});

describe('环境变量配置', () => {
  it('缺少 LLM_API_KEY 时返回 null', () => {
    assert.equal(readEnvConfig({}), null);
    assert.equal(readEnvConfig({ LLM_API_KEY: '   ' }), null);
  });

  it('有 key 时给出默认 baseUrl 与 model', () => {
    const config = readEnvConfig({ LLM_API_KEY: 'k' });
    assert.deepEqual(config, {
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      timeoutMs: 60_000,
    });
  });

  it('读取自定义地址、模型与超时', () => {
    const config = readEnvConfig({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: 'qwen',
      LLM_TIMEOUT_MS: '1500',
    });
    assert.equal(config?.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(config?.model, 'qwen');
    assert.equal(config?.timeoutMs, 1500);
  });

  it('非法超时回落到默认值', () => {
    assert.equal(readEnvConfig({ LLM_API_KEY: 'k', LLM_TIMEOUT_MS: '-5' })?.timeoutMs, 60_000);
    assert.equal(readEnvConfig({ LLM_API_KEY: 'k', LLM_TIMEOUT_MS: 'abc' })?.timeoutMs, 60_000);
  });

  it('createClientFromEnv 在缺少 key 时抛可读错误', () => {
    assert.throws(() => createClientFromEnv({}), /LLM_API_KEY/);
  });
});
