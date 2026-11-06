/**
 * 用量 / 额度记账测试：累计、缺失字段按 0、预算停止、可选落盘。
 * 落盘全部写到 os.tmpdir()，不污染项目目录；不访问网络。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BUDGET_ENV_KEY,
  DEFAULT_USAGE_FILE,
  UsageTracker,
  readBudgetTokens,
  resolveUsageFile,
  usageFilePathFromEnv,
} from '../src/usage.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mini-agent-usage-'));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('UsageTracker：累计', () => {
  it('prompt / completion / total / 调用次数累计正确', () => {
    const tracker = new UsageTracker();
    tracker.recordUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    tracker.recordUsage({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.promptTokens, 13);
    assert.equal(snapshot.completionTokens, 7);
    assert.equal(snapshot.totalTokens, 20);
    assert.equal(snapshot.calls, 2);
    assert.equal(snapshot.failures, 0);
    assert.equal(snapshot.retries, 0);
    assert.equal(snapshot.missingUsageCalls, 0);
    assert.equal(snapshot.overBudget, false);
  });

  it('缺失 usage / 缺字段按 0 计，并记录上游未给', () => {
    const tracker = new UsageTracker();
    tracker.recordUsage();
    tracker.recordUsage(null);
    tracker.recordUsage({ promptTokens: 7 });

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.calls, 3);
    assert.equal(snapshot.promptTokens, 7);
    assert.equal(snapshot.completionTokens, 0);
    assert.equal(snapshot.totalTokens, 0);
    assert.equal(snapshot.missingUsageCalls, 3);

    const summary = tracker.summary();
    assert.match(summary, /total=0/);
    assert.match(summary, /prompt=7/);
    assert.match(summary, /上游未给 usage 的调用 3 次（缺字段按 0 计）/);  });

  it('失败与重试次数独立累计，reset 可清零', () => {
    const tracker = new UsageTracker();
    tracker.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    tracker.recordFailure();
    tracker.recordFailure();
    tracker.recordRetry();
    tracker.recordRetry(2);

    let snapshot = tracker.snapshot();
    assert.equal(snapshot.failures, 2);
    assert.equal(snapshot.retries, 3);

    tracker.reset();
    snapshot = tracker.snapshot();
    assert.deepEqual(snapshot, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 0,
      failures: 0,
      retries: 0,
      missingUsageCalls: 0,
      overBudget: false,
    });
  });

  it('summary 同时给出 total / prompt / completion / 重试次数', () => {
    const tracker = new UsageTracker();
    tracker.recordUsage({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
    tracker.recordRetry();
    assert.equal(
      tracker.summary(),
      'total=12（prompt=5 / completion=7），调用 1 次，失败 0 次，重试 1 次',
    );
  });
});

describe('UsageTracker：预算', () => {
  it('达到预算后 isOverBudget 为 true，remaining 归零', () => {
    const tracker = new UsageTracker({ budgetTokens: 20 });
    tracker.recordUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assert.equal(tracker.isOverBudget(), false);
    assert.equal(tracker.remainingTokens(), 5);

    tracker.recordUsage({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    assert.equal(tracker.isOverBudget(), true);
    assert.equal(tracker.remainingTokens(), 0);

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.budgetTokens, 20);
    assert.equal(snapshot.overBudget, true);
    assert.match(tracker.summary(), /预算 20（剩余 0）/);
  });

  it('非法预算被忽略', () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tracker = new UsageTracker({ budgetTokens: budget });
      assert.equal(tracker.budgetTokens, undefined);
      assert.equal(tracker.isOverBudget(), false);
      assert.equal(tracker.remainingTokens(), undefined);
    }
  });
});

describe('UsageTracker：落盘', () => {
  it('AGENT_USAGE_FILE 指向的文件落盘后内容可 JSON.parse', async () => {
    const dir = await tempDir();
    const target = path.join(dir, DEFAULT_USAGE_FILE);
    const fromEnv = usageFilePathFromEnv({ AGENT_USAGE_FILE: target });
    assert.equal(fromEnv, target);
    const tracker = new UsageTracker({ filePath: fromEnv, now: () => 1_700_000_000_000 });

    tracker.recordUsage({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
    tracker.recordFailure();
    tracker.recordRetry();
    await tracker.flush();

    const parsed = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    assert.equal(parsed['version'], 1);
    assert.equal(parsed['updatedAt'], new Date(1_700_000_000_000).toISOString());
    assert.equal(parsed['promptTokens'], 4);
    assert.equal(parsed['completionTokens'], 6);
    assert.equal(parsed['totalTokens'], 10);
    assert.equal(parsed['calls'], 1);
    assert.equal(parsed['failures'], 1);
    assert.equal(parsed['retries'], 1);
    assert.equal(parsed['missingUsageCalls'], 0);
    assert.equal(tracker.persistError, undefined);
  });

  it('未配置 filePath 时 flush 是 no-op（不报错）', async () => {
    const tracker = new UsageTracker();
    await tracker.flush();
  });

  it('默认文件名是 .agent-usage.json', () => {
    assert.equal(DEFAULT_USAGE_FILE, '.agent-usage.json');
    assert.equal(usageFilePathFromEnv({ AGENT_USAGE_FILE: '1' }), DEFAULT_USAGE_FILE);
    assert.equal(usageFilePathFromEnv({ AGENT_USAGE_FILE: 'true' }), DEFAULT_USAGE_FILE);
    assert.equal(usageFilePathFromEnv({ AGENT_USAGE_FILE: 'custom/usage.json' }), 'custom/usage.json');
    assert.equal(usageFilePathFromEnv({ AGENT_USAGE_FILE: '0' }), undefined);
    assert.equal(usageFilePathFromEnv({ AGENT_USAGE_FILE: '' }), undefined);
    assert.equal(usageFilePathFromEnv({}), undefined);
  });

  it('resolveUsageFile：--usage 或环境变量任一开启', () => {
    assert.equal(resolveUsageFile({ enabled: true, env: {} }), DEFAULT_USAGE_FILE);
    assert.equal(
      resolveUsageFile({ enabled: false, env: { AGENT_USAGE_FILE: 'x.json' } }),
      'x.json',
    );
    assert.equal(resolveUsageFile({ enabled: false, env: {} }), undefined);
  });

  it('readBudgetTokens 只接受正数', () => {
    assert.equal(readBudgetTokens({ [BUDGET_ENV_KEY]: '1000' }), 1000);
    assert.equal(readBudgetTokens({ [BUDGET_ENV_KEY]: '0' }), undefined);
    assert.equal(readBudgetTokens({ [BUDGET_ENV_KEY]: '-5' }), undefined);
    assert.equal(readBudgetTokens({ [BUDGET_ENV_KEY]: 'abc' }), undefined);
    assert.equal(readBudgetTokens({}), undefined);
  });
});
