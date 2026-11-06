/**
 * weather 工具测试：全部用注入的假 fetch，不发真实网络请求。
 *
 * 覆盖：命中、城市无结果、上游非 2xx、超时、天气码映射、days=3 日预报解析。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWeatherTool, describeWeatherCode, weatherTool } from '../src/tools/weather.js';
import type { ToolResult } from '../src/types.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按 URL 分派的假 fetch，记录所有请求 */
function makeFetch(handler: (url: string) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, init });
    return handler(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

const geoPayload = {
  results: [
    { name: '北京', country: '中国', latitude: 39.9075, longitude: 116.39723 },
  ],
};

const forecastPayload = {
  current: {
    temperature_2m: 11.4,
    relative_humidity_2m: 62,
    apparent_temperature: 9.8,
    weather_code: 3,
    wind_speed_10m: 7.2,
  },
  daily: {
    time: ['2026-02-01', '2026-02-02', '2026-02-03'],
    weather_code: [0, 61, 95],
    temperature_2m_max: [14.2, 10.6, 8.1],
    temperature_2m_min: [3.1, 2.4, 0.5],
    precipitation_probability_max: [10, 80, 65],
  },
};

function run(args: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<ToolResult> {
  return weatherTool.run(args, { toolName: 'weather', ...(fetchImpl ? { fetchImpl } : {}) });
}

describe('weather：天气码映射', () => {
  const cases: Array<[number, string]> = [
    [0, '晴'],
    [1, '多云'],
    [2, '多云'],
    [3, '多云'],
    [45, '雾'],
    [48, '雾'],
    [51, '雨'],
    [61, '雨'],
    [67, '雨'],
    [71, '雪'],
    [77, '雪'],
    [95, '雷暴'],
    [96, '雷暴'],
    [99, '雷暴'],
    [82, '未知(82)'],
  ];

  for (const [code, expected] of cases) {
    it(`${code} -> ${expected}`, () => {
      assert.equal(describeWeatherCode(code), expected);
    });
  }
});

describe('weather：查询流程', () => {
  it('命中时输出中文摘要，不回吐原始 JSON', async () => {
    const { fetchImpl, captured } = makeFetch((url) =>
      url.startsWith('https://geocoding-api.open-meteo.com/v1/search') ? jsonResponse(geoPayload) : jsonResponse(forecastPayload),
    );

    const result = await run({ city: '北京' }, fetchImpl);

    assert.equal(result.ok, true);
    assert.match(result.output, /北京（中国）当前天气/);
    assert.match(result.output, /- 天气：多云/);
    assert.match(result.output, /- 温度：11\.4°C（体感 9\.8°C）/);
    assert.match(result.output, /- 湿度：62%/);
    assert.match(result.output, /- 风速：7\.2 km\/h/);
    assert.doesNotMatch(result.output, /weather_code/);
    assert.doesNotMatch(result.output, /\{"/);

    // 两个请求的地址符合 Open-Meteo 约定
    assert.equal(captured.length, 2);
    assert.match(captured[0]!.url, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=/);
    assert.match(captured[0]!.url, /count=1/);
    assert.match(captured[0]!.url, /language=zh/);
    assert.match(captured[1]!.url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=39\.9075&longitude=116\.39723/);
    assert.match(captured[1]!.url, /forecast_days=1/);
    assert.match(captured[1]!.url, /current=temperature_2m/);
  });

  it('days=3 时附三天预报，且 forecast_days=3', async () => {
    const { fetchImpl, captured } = makeFetch((url) =>
      url.startsWith('https://geocoding-api.open-meteo.com') ? jsonResponse(geoPayload) : jsonResponse(forecastPayload),
    );

    const result = await run({ city: '北京', days: 3 }, fetchImpl);

    assert.equal(result.ok, true);
    assert.match(result.output, /未来 3 天预报/);
    assert.match(result.output, /- 2026-02-01：晴，最高 14\.2°C \/ 最低 3\.1°C，降水概率 10%/);
    assert.match(result.output, /- 2026-02-02：雨，最高 10\.6°C \/ 最低 2\.4°C，降水概率 80%/);
    assert.match(result.output, /- 2026-02-03：雷暴，最高 8\.1°C \/ 最低 0\.5°C，降水概率 65%/);
    assert.match(captured[1]!.url, /forecast_days=3/);
  });

  it('days 超出范围时归一化到 1-3', async () => {
    const { fetchImpl, captured } = makeFetch((url) =>
      url.startsWith('https://geocoding-api.open-meteo.com') ? jsonResponse(geoPayload) : jsonResponse(forecastPayload),
    );

    await run({ city: '北京', days: 9 }, fetchImpl);
    assert.match(captured[1]!.url, /forecast_days=3/);

    const single = makeFetch((url) =>
      url.startsWith('https://geocoding-api.open-meteo.com') ? jsonResponse(geoPayload) : jsonResponse(forecastPayload),
    );
    const result = await run({ city: '北京', days: 0 }, single.fetchImpl);
    assert.doesNotMatch(result.output, /未来 /);
    assert.match(single.captured[1]!.url, /forecast_days=1/);
  });

  it('城市无结果时 ok=false 并说明原因', async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({ generationtime_ms: 0.1 }));
    const result = await run({ city: '不存在城' }, fetchImpl);

    assert.equal(result.ok, false);
    assert.equal(result.error, 'CITY_NOT_FOUND');
    assert.equal(result.retryable, false);
    // 城市没找到就不该再去查预报
    assert.equal(captured.length, 1);
  });

  it('上游非 2xx 时 ok=false 并带状态码', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ error: true, reason: 'boom' }, 500));
    const result = await run({ city: '北京' }, fetchImpl);

    assert.equal(result.ok, false);
    assert.match(result.output, /HTTP 500/);
    assert.equal(result.retryable, true);
  });

  it('请求超时（AbortSignal.timeout）时 ok=false 并说明超时', async () => {
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;

    const fastTool = createWeatherTool({ fetchImpl: hangingFetch, timeoutMs: 20 });
    const result = await fastTool.run({ city: '北京' }, { toolName: 'weather' });

    assert.equal(result.ok, false);
    assert.match(result.output, /超时/);
  });

  it('city 缺失时 ok=false', async () => {
    const result = await run({});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'CITY_REQUIRED');
    assert.equal(result.retryable, false);
  });

  it('假 fetch 被调用时带上了 AbortSignal（超时可控）', async () => {
    const { fetchImpl, captured } = makeFetch((url) =>
      url.startsWith('https://geocoding-api.open-meteo.com') ? jsonResponse(geoPayload) : jsonResponse(forecastPayload),
    );
    await run({ city: '北京' }, fetchImpl);
    assert.ok(captured[0]!.init?.signal instanceof AbortSignal);
  });
});
