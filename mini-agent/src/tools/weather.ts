/**
 * weather 工具：查城市当前天气与 1-3 天预报。
 *
 * 一句话功能：调用 Open-Meteo（免 key）先做地理编码再查天气，输出中文人话摘要。
 * 参数：city（必填，城市名，如「北京」）；days（可选，1-3，默认 1，>1 时附每日预报）。
 * 返回：中文摘要——城市+国家、当前天气/温度/体感/湿度/风速，以及每日日期/最高最低/降水概率；
 *      不回吐原始 JSON。
 * 失败情况：城市未找到、上游非 2xx、响应格式异常、请求超时（默认 8s）都折算成 ok=false。
 *
 * 离线可测：fetch 可注入（ToolContext.fetchImpl 或 createWeatherTool 的 fetchImpl），
 * 测试用假响应覆盖命中、无结果、非 2xx、超时、天气码映射与多日预报。
 */

import { defineTool, toolFail, toolOk } from './base.js';
import type { Tool, ToolContext } from './base.js';

const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** 默认超时 8 秒 */
const DEFAULT_TIMEOUT_MS = 8000;

/** weather 专用错误，便于区分「上游/城市/超时」；retryable 表示是否值得重试 */
export class WeatherError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'WeatherError';
    this.retryable = retryable;
  }
}

/** WMO weather_code -> 中文 */
export function describeWeatherCode(code: number): string {
  if (code === 0) return '晴';
  if (code >= 1 && code <= 3) return '多云';
  if (code === 45 || code === 48) return '雾';
  if (code >= 51 && code <= 67) return '雨';
  if (code >= 71 && code <= 77) return '雪';
  if (code >= 95 && code <= 99) return '雷暴';
  return `未知(${code})`;
}

interface GeocodingResult {
  name?: string;
  country?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
}

interface GeocodingResponse {
  results?: GeocodingResult[];
}

interface ForecastCurrent {
  temperature_2m?: number;
  relative_humidity_2m?: number;
  apparent_temperature?: number;
  weather_code?: number;
  wind_speed_10m?: number;
}

interface ForecastDaily {
  time?: string[];
  weather_code?: number[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
}

interface ForecastResponse {
  current?: ForecastCurrent;
  daily?: ForecastDaily;
}

function formatNumber(value: number | undefined, unit: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `未知${unit}`;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

function describeError(error: unknown): string {
  if (error instanceof WeatherError) return error.message;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return '请求 Open-Meteo 超时';
  }
  return message || name || '未知错误';
}

async function fetchJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new WeatherError(`请求 Open-Meteo 超时（${timeoutMs}ms）`);
    }
    throw new WeatherError(`请求 Open-Meteo 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    throw new WeatherError(`Open-Meteo 返回 HTTP ${response.status}（${url}）`, retryable);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new WeatherError('Open-Meteo 返回的不是合法 JSON', true);
  }
}

function readDays(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(3, Math.max(1, Math.floor(parsed)));
}

export interface WeatherToolOptions {
  /** 可注入的 fetch，默认 globalThis.fetch（可被 ToolContext.fetchImpl 覆盖） */
  fetchImpl?: typeof fetch;
  /** 单次请求超时，默认 8000ms */
  timeoutMs?: number;
}

/** 组装一份中文天气摘要 */
export function formatWeatherSummary(
  location: GeocodingResult,
  forecast: ForecastResponse,
  days: number,
): string {
  const current = forecast.current ?? {};
  const city = location.name ?? '未知城市';
  const region = location.country ?? location.country_code ?? '未知地区';

  const lines: string[] = [
    `${city}（${region}）当前天气`,
    `- 天气：${describeWeatherCode(current.weather_code ?? -1)}`,
    `- 温度：${formatNumber(current.temperature_2m, '°C')}（体感 ${formatNumber(current.apparent_temperature, '°C')}）`,
    `- 湿度：${formatNumber(current.relative_humidity_2m, '%')}`,
    `- 风速：${formatNumber(current.wind_speed_10m, ' km/h')}`,
  ];

  const daily = forecast.daily;
  const dates = daily?.time ?? [];
  if (days > 1 && dates.length > 0) {
    lines.push('', `未来 ${Math.min(days, dates.length)} 天预报`);
    for (let index = 0; index < Math.min(days, dates.length); index += 1) {
      const code = daily?.weather_code?.[index];
      const max = daily?.temperature_2m_max?.[index];
      const min = daily?.temperature_2m_min?.[index];
      const rain = daily?.precipitation_probability_max?.[index];
      lines.push(
        `- ${dates[index]}：${describeWeatherCode(code ?? -1)}，最高 ${formatNumber(max, '°C')} / 最低 ${formatNumber(min, '°C')}，降水概率 ${formatNumber(rain, '%')}`,
      );
    }
  }

  return lines.join('\n');
}

/** 创建 weather 工具（可注入 fetch / 超时，便于离线测试） */
export function createWeatherTool(options: WeatherToolOptions = {}): Tool {
  const defaultFetch = options.fetchImpl;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return defineTool({
    name: 'weather',
    description:
      '查询城市当前天气与 1-3 天预报（数据源 Open-Meteo，免 key），输出中文摘要；需要联网。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，例如「北京」「上海」' },
        days: { type: 'integer', description: '预报天数 1-3，默认 1', default: 1 },
      },
      required: ['city'],
      additionalProperties: false,
    },
    todo: [
      '查询某个城市此刻的天气与未来 1-3 天的预报，用于回答穿衣、出行类问题。',
      '第一步：校验 city 非空，days 归一化到 1-3（默认 1）。',
      '第二步：调用 Open-Meteo 地理编码接口拿经纬度与国家；没有结果直接判定城市未找到。',
      '第三步：调用 forecast 接口取当前天气与每日预报。',
      '第四步：把 weather_code 映射成中文，拼成「城市+国家 / 温度体感湿度风速 / 每日高低温与降水概率」的摘要。',
      '边界：需要联网；只按城市名查询第一个匹配结果；不支持区县级别定位与历史天气。',
      '失败情况：城市不存在、上游非 2xx、响应格式异常、8 秒超时，均返回 ok=false 并说明原因。',
    ],
    async run(args, ctx: ToolContext) {
      const rawCity = args['city'];
      if (typeof rawCity !== 'string' || rawCity.trim() === '') {
        return toolFail('city 必须是非空字符串，例如「北京」', 'CITY_REQUIRED', false);
      }
      const city = rawCity.trim();
      const days = readDays(args['days']);
      const fetchImpl = ctx.fetchImpl ?? defaultFetch ?? globalThis.fetch;
      const timeoutMs = defaultTimeout;

      if (typeof fetchImpl !== 'function') {
        return toolFail('当前运行时没有可用的 fetch，无法查询天气', 'NO_FETCH', false);
      }

      try {
        const geoUrl = `${GEOCODING_ENDPOINT}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
        const geoPayload = (await fetchJson(geoUrl, fetchImpl, timeoutMs)) as GeocodingResponse;
        const location = geoPayload.results?.[0];
        if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
          return toolFail(
            `没有找到城市「${city}」的地理位置，请确认城市名（Open-Meteo 地理编码支持中英文城市名）。`,
            'CITY_NOT_FOUND',
            false,
          );
        }

        const forecastUrl =
          `${FORECAST_ENDPOINT}?latitude=${location.latitude}&longitude=${location.longitude}` +
          '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
          `&timezone=auto&forecast_days=${days}`;
        const forecast = (await fetchJson(forecastUrl, fetchImpl, timeoutMs)) as ForecastResponse;

        const summary = formatWeatherSummary(location, forecast, days);
        return toolOk(summary, { city: location.name ?? city, days });
      } catch (error) {
        const retryable = error instanceof WeatherError ? error.retryable : true;
        return toolFail(`天气查询失败：${describeError(error)}`, 'WEATHER_FAILED', retryable);
      }
    },
  });
}

/** 默认实例：用全局 fetch、8 秒超时；测试可注入 ctx.fetchImpl 覆盖 */
export const weatherTool = createWeatherTool();
