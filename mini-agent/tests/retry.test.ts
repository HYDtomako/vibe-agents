/**
 * 重试与退避测试：全部注入 recordingSleep，不产生真实等待、不访问网络。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RetryError,
  computeBackoffDelay,
  parseRetryAfterMs,
  withRetry,
} from '../src/retry.js';

function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('withRetry：成功路径', () => {
  it('可重试错误在第 2 次尝试成功', async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('ETIMEDOUT');
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 300, jitter: false, sleep, shouldRetry: () => true },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [300]);
  });

  it('第一次就成功时 sleep 一次都不调用', async () => {
    const { waits, sleep } = recordingSleep();
    const result = await withRetry(async () => 'first', { sleep });
    assert.equal(result, 'first');
    assert.deepEqual(waits, []);
  });
});

describe('withRetry：重试耗尽与不重试', () => {
  it('重试耗尽抛 RetryError，保留尝试次数与退避序列', async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error('ECONNRESET');
          },
          { maxAttempts: 3, baseDelayMs: 300, jitter: false, sleep },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RetryError);
        assert.equal(error.attempts, 3);
        assert.equal(error.stopReason, 'exhausted');
        assert.deepEqual(error.delays, [300, 600]);
        assert.match((error.lastError as Error).message, /ECONNRESET/);
        return true;
      },
    );

    assert.equal(calls, 3);
    assert.deepEqual(waits, [300, 600]);
  });

  it('shouldRetry=false 时只调用 1 次，不 sleep', async () => {    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const attempts: Array<[number, number]> = [];

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error('参数非法');
          },
          {
            maxAttempts: 3,
            sleep,
            shouldRetry: () => false,
            onAttempt: (attempt, _error, delayMs) => {
              attempts.push([attempt, delayMs]);
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RetryError);
        assert.equal(error.attempts, 1);
        assert.equal(error.stopReason, 'not_retryable');
        return true;
      },
    );

    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(attempts, [[1, 0]]);
  });

  it('重试耗尽后调用方可以返回兜底结果（loop 的失败回执同理）', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;

    const fallback = await withRetry(
      async () => {
        calls += 1;
        throw new Error('ETIMEDOUT');
      },
      { maxAttempts: 3, baseDelayMs: 10, jitter: false, sleep },
    ).catch((error: unknown) => {
      assert.ok(error instanceof RetryError);
      return `兜底：第 ${error.attempts} 次尝试仍失败`;
    });

    assert.equal(fallback, '兜底：第 3 次尝试仍失败');
    assert.equal(calls, 3);
  });
});

describe('withRetry：指数退避与抖动', () => {
  it('退避序列符合 base * 2^(attempt-1)', async () => {
    const { waits, sleep } = recordingSleep();
    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('boom');
        },
        { maxAttempts: 4, baseDelayMs: 100, jitter: false, sleep },
      ),
    );
    assert.deepEqual(waits, [100, 200, 400]);
  });

  it('单次等待封顶 maxDelayMs', async () => {
    const { waits, sleep } = recordingSleep();
    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('boom');
        },
        { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 1500, jitter: false, sleep },
      ),
    );
    assert.deepEqual(waits, [1000, 1500, 1500]);
  });

  it('抖动落在 50%-100% 区间（random 可注入）', async () => {
    const low = recordingSleep();
    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('boom');
        },
        { maxAttempts: 3, baseDelayMs: 300, jitter: true, random: () => 0, sleep: low.sleep },
      ),
    );
    assert.deepEqual(low.waits, [150, 300]);

    const high = recordingSleep();
    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('boom');
        },
        { maxAttempts: 3, baseDelayMs: 300, jitter: true, random: () => 1, sleep: high.sleep },
      ),
    );
    assert.deepEqual(high.waits, [300, 600]);
  });

  it('computeBackoffDelay 是纯函数，可直接断言', () => {
    assert.equal(computeBackoffDelay(1, { baseDelayMs: 300, jitter: false }), 300);
    assert.equal(computeBackoffDelay(3, { baseDelayMs: 300, jitter: false }), 1200);
    assert.equal(computeBackoffDelay(9, { baseDelayMs: 300, maxDelayMs: 4000, jitter: false }), 4000);
    assert.equal(computeBackoffDelay(1, { baseDelayMs: 300, jitter: false, maxDelayMs: 0 }), 0);
  });
});

describe('withRetry：Retry-After 优先', () => {
  it('服务端 Retry-After 优先于本地指数退避，并封顶 maxDelayMs', async () => {
    const { waits, sleep } = recordingSleep();
    const attempts: number[] = [];
    const error = Object.assign(new Error('HTTP 429'), { retryAfterMs: 2000 });

    await assert.rejects(() =>
      withRetry(
        async () => {
          throw error;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 300,
          maxDelayMs: 1500,
          jitter: false,
          sleep,
          onAttempt: (_attempt, _error, delayMs) => {
            attempts.push(delayMs);
          },
        },
      ),
    );

    assert.deepEqual(waits, [1500, 1500]);
    assert.deepEqual(attempts, [1500, 1500, 0]);
  });

  it('Retry-After 小于本地退避时直接采用服务端建议', async () => {
    const { waits, sleep } = recordingSleep();
    const error = Object.assign(new Error('HTTP 429'), { retryAfterMs: 100 });

    await assert.rejects(() =>
      withRetry(
        async () => {
          throw error;
        },
        { maxAttempts: 2, baseDelayMs: 300, jitter: false, sleep },
      ),
    );

    assert.deepEqual(waits, [100]);
  });

  it('兼容 HTTP 头形式的 Retry-After（秒）', async () => {
    const { waits, sleep } = recordingSleep();
    const error = Object.assign(new Error('HTTP 503'), {
      headers: { get: (name: string) => (name === 'retry-after' ? '2' : null) },
    });

    await assert.rejects(() =>
      withRetry(
        async () => {
          throw error;
        },
        { maxAttempts: 2, baseDelayMs: 300, jitter: false, sleep },
      ),
    );

    assert.deepEqual(waits, [2000]);
  });

  it('parseRetryAfterMs 支持秒数与 HTTP 日期', () => {
    const now = 1_700_000_000_000;
    assert.equal(parseRetryAfterMs('2', now), 2000);
    assert.equal(parseRetryAfterMs(new Date(now + 3000).toUTCString(), now), 3000);
    assert.equal(parseRetryAfterMs(null, now), undefined);
    assert.equal(parseRetryAfterMs('not-a-date', now), undefined);
  });
});

describe('withRetry：回调、deadline 与取消', () => {
  it('onAttempt 记录每次失败与等待时长（最后一次为 0）', async () => {
    const { sleep } = recordingSleep();
    const seen: Array<[number, number]> = [];

    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('boom');
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          jitter: false,
          sleep,
          onAttempt: (attempt, _error, delayMs) => {
            seen.push([attempt, delayMs]);
          },
        },
      ),
    );

    assert.deepEqual(seen, [
      [1, 100],
      [2, 200],
      [3, 0],
    ]);
  });

  it('总耗时预算（deadlineMs）到就放弃', async () => {
    const waits: number[] = [];
    let clock = 0;
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error('ETIMEDOUT');
          },
          {
            maxAttempts: 4,
            baseDelayMs: 300,
            jitter: false,
            deadlineMs: 500,
            now: () => clock,
            sleep: async (ms) => {
              waits.push(ms);
              clock += ms;
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RetryError);
        assert.equal(error.stopReason, 'deadline');
        assert.equal(error.attempts, 2);
        return true;
      },
    );

    assert.equal(calls, 2);
    assert.deepEqual(waits, [300]);
  });

  it('signal 已取消时不再发起尝试', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            return 'nope';
          },
          { signal: controller.signal },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RetryError);
        assert.equal(error.stopReason, 'aborted');
        assert.equal(error.attempts, 0);
        return true;
      },
    );

    assert.equal(calls, 0);
  });
});
