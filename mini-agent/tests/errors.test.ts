/**
 * 错误分类表测试：工具失败 / 模型失败落到 retryable / fatal / quota / bad_request。
 * 全部离线，不访问网络。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ERROR_KIND_LABELS,
  classifyModelError,
  classifyToolError,
  isRetryableKind,
  readRetryAfterMs,
} from '../src/errors.js';
import { ModelError } from '../src/model.js';
import type { ToolResult } from '../src/types.js';

function fail(output: string, error?: string, retryable?: boolean): ToolResult {
  const result: ToolResult = { ok: false, output };
  if (error !== undefined) result.error = error;
  if (retryable !== undefined) result.retryable = retryable;
  return result;
}

describe('classifyToolError：可重试', () => {
  const cases: Array<[string, ToolResult]> = [
    ['ETIMEDOUT', fail('请求超时', 'ETIMEDOUT')],
    ['AbortError', fail('请求被中断', 'AbortError')],
    ['ECONNRESET', fail('连接被重置', 'ECONNRESET')],
    ['ENOTFOUND', fail('DNS 解析失败', 'ENOTFOUND')],
    ['EAI_AGAIN', fail('DNS 暂时失败', 'EAI_AGAIN')],
    ['上游 5xx', fail('Open-Meteo 返回 HTTP 503', 'WEATHER_FAILED')],
    ['429', fail('上游返回 429', 'UPSTREAM')],
    ['RATE_LIMIT', fail('RATE_LIMIT exceeded', 'RATE_LIMIT')],
    ['网络错误', fail('fetch failed: network unreachable')],
    ['工具显式声明 true', fail('未知失败', 'UNKNOWN', true)],
  ];

  for (const [name, result] of cases) {
    it(`${name} -> retryable`, () => {
      const classified = classifyToolError(result);
      assert.equal(classified.kind, 'retryable');
      assert.match(classified.reason, /重试|网络|超时|限流|上游/);
    });
  }
});

describe('classifyToolError：确定性失败（fatal）', () => {
  const cases: Array<[string, ToolResult]> = [
    ['INVALID_ARGUMENTS_JSON', fail('参数不是合法 JSON', 'INVALID_ARGUMENTS_JSON')],
    ['INVALID_ARGUMENTS_TYPE', fail('参数必须是 JSON 对象', 'INVALID_ARGUMENTS_TYPE')],
    ['UNKNOWN_TOOL', fail('未知工具：nope', 'UNKNOWN_TOOL')],
    ['schema 校验失败', fail('schema validation failed: expression is required')],
    ['路径越界', fail('路径越出允许的根目录：../etc/passwd', 'PATH_ESCAPE')],
    ['符号链接逃逸', fail('路径经符号链接指向根目录之外', 'PATH_SYMLINK_ESCAPE')],
    ['edit_file 唯一性冲突', fail('oldText 在 a.txt 中出现了 2 次', 'TEXT_NOT_UNIQUE')],
    ['文件不存在', fail('文件不存在：a.txt', 'FILE_NOT_FOUND')],
    ['城市未找到', fail('没有找到城市「不存在城」', 'CITY_NOT_FOUND')],
    ['工具显式声明 false', fail('请求超时', 'ETIMEDOUT', false)],
    ['未知工具错误默认 fatal', fail('某个说不清的失败')],
  ];

  for (const [name, result] of cases) {
    it(`${name} -> fatal`, () => {
      const classified = classifyToolError(result);
      assert.equal(classified.kind, 'fatal');
      assert.ok(classified.reason.length > 0);
    });
  }
});

describe('classifyToolError：额度 / 计费', () => {
  const cases: Array<[string, ToolResult]> = [
    ['insufficient_quota', fail('insufficient_quota', 'QUOTA')],
    ['billing_hard_limit_reached', fail('billing_hard_limit_reached', 'BILLING')],
    ['quota exceeded', fail('quota exceeded for this account')],
    ['402', fail('上游返回 HTTP 402')],
    ['401 + api key', fail('HTTP 401 invalid api key')],
    ['403 + 额度', fail('HTTP 403：额度已用尽')],
  ];

  for (const [name, result] of cases) {
    it(`${name} -> quota`, () => {
      const classified = classifyToolError(result);
      assert.equal(classified.kind, 'quota');
      assert.match(classified.reason, /额度|计费/);
    });
  }
});

describe('classifyModelError：按 status 与 body', () => {
  it('429 -> retryable，并带上 Retry-After', () => {
    const classified = classifyModelError(new ModelError('模型调用失败：HTTP 429', 429, 'rate limit', 1500));
    assert.equal(classified.kind, 'retryable');
    assert.equal(classified.status, 429);
    assert.equal(classified.retryAfterMs, 1500);
  });

  it('408 / 500 / 502 / 503 -> retryable', () => {
    for (const status of [408, 500, 502, 503]) {
      const classified = classifyModelError(new ModelError(`HTTP ${status}`, status));
      assert.equal(classified.kind, 'retryable', `status ${status}`);
    }
  });

  it('网络错误与超时（status=0）-> retryable', () => {
    assert.equal(
      classifyModelError(new ModelError('模型调用网络错误：fetch failed', 0)).kind,
      'retryable',
    );
    assert.equal(classifyModelError(new ModelError('模型调用超时（60000ms）', 0)).kind, 'retryable');
    assert.equal(classifyModelError(new Error('ECONNRESET')).kind, 'retryable');
  });

  it('限流文本（没有 status）-> retryable', () => {
    assert.equal(classifyModelError(new Error('rate limit exceeded')).kind, 'retryable');
  });

  it('400 / 401 / 403 / 404 / 413 / 422 -> bad_request', () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      const classified = classifyModelError(new ModelError(`HTTP ${status}`, status, 'invalid request'));
      assert.equal(classified.kind, 'bad_request', `status ${status}`);
    }
  });

  it('401 不会因为消息里有 key 就被误判为配额', () => {
    const classified = classifyModelError(
      new ModelError('模型调用失败：HTTP 401', 401, 'invalid api key'),
    );
    assert.equal(classified.kind, 'bad_request');
  });

  it('402 -> quota', () => {
    const classified = classifyModelError(new ModelError('模型调用失败：HTTP 402', 402));
    assert.equal(classified.kind, 'quota');
  });

  it('400 + body insufficient_quota -> quota', () => {
    const classified = classifyModelError(
      new ModelError('模型调用失败：HTTP 400', 400, '{"error":"insufficient_quota"}'),
    );
    assert.equal(classified.kind, 'quota');
  });

  it('billing 关键字 -> quota', () => {
    assert.equal(
      classifyModelError(new ModelError('HTTP 403', 403, 'billing_hard_limit_reached')).kind,
      'quota',
    );
  });

  it('无法识别的错误 -> bad_request（不盲目重试）', () => {
    assert.equal(classifyModelError(new Error('something odd')).kind, 'bad_request');
    assert.equal(classifyModelError('字符串错误').kind, 'bad_request');
  });
});

describe('错误分类辅助函数', () => {
  it('isRetryableKind 只对 retryable 返回 true', () => {
    assert.equal(isRetryableKind('retryable'), true);
    assert.equal(isRetryableKind('fatal'), false);
    assert.equal(isRetryableKind('quota'), false);
    assert.equal(isRetryableKind('bad_request'), false);
  });

  it('每种 kind 都有中文标签', () => {
    for (const kind of ['retryable', 'fatal', 'quota', 'bad_request'] as const) {
      assert.ok(ERROR_KIND_LABELS[kind].length > 0);
    }
  });

  it('readRetryAfterMs 兼容 retryAfterMs / retryAfter(秒) / headers', () => {
    assert.equal(readRetryAfterMs({ retryAfterMs: 1200 }), 1200);
    assert.equal(readRetryAfterMs({ retryAfter: 2 }), 2000);
    assert.equal(readRetryAfterMs({ headers: { get: () => '3' } }), 3000);
    assert.equal(readRetryAfterMs(new Error('无')), undefined);
  });

  it('成功的工具结果不会被当成失败', () => {
    assert.equal(classifyToolError({ ok: true, output: 'ok' }).kind, 'fatal');
  });
});
