/**
 * 零依赖 .env 加载器。
 *
 * 解析规则：
 * - 空行、`#` 开头的注释行忽略（行首允许空白）；
 * - 支持可选 `export ` 前缀；一行只取第一个 `=` 作为分隔符；
 * - 值两侧是成对引号（`"` 或 `'`）时去掉引号，引号内的 `#`、`=` 原样保留；
 * - 兼容 CRLF（行尾 `\r` 与 BOM 一并去掉）；没有 `=` 的行直接忽略，不报错；
 * - KEY 只接受 `[A-Za-z_][A-Za-z0-9_]*`，不合法的行忽略；同名键后者覆盖前者。
 *
 * 行为：
 * - 目标环境里已存在的键一律不覆盖（真实环境变量优先）；
 * - 文件不存在或读不出来时静默跳过，不抛错。
 *
 * 对外只暴露键名与计数：返回值、异常与日志都不含变量值。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** 默认文件名 */
export const ENV_FILE_NAME = '.env';

/** 合法键名：字母或下划线开头，后接字母/数字/下划线 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `export KEY=VALUE` 前缀（export 后允许空白或制表符） */
const EXPORT_PREFIX = /^export\s+/;

/** BOM */
const BOM = '\uFEFF';

export interface LoadEnvOptions {
  /** .env 所在目录，默认 process.cwd() */
  cwd?: string;
  /** 要读写环境变量的对象，默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 文件名，默认 '.env' */
  filename?: string;
}

export interface EnvLoadResult {
  /** 实际读取的文件绝对路径；文件不存在或读不出来时为 null */
  path: string | null;
  /** 本次真正写入环境的键名（按文件顺序，不含值） */
  loaded: string[];
  /** 目标环境里已存在、因此跳过的键名（不含值） */
  skipped: string[];
}

/** 去掉值两侧成对的引号；不成对就原样返回 */
function normalizeValue(raw: string): string {
  const quote = raw.charAt(0);
  if (raw.length >= 2 && (quote === '"' || quote === "'") && raw.endsWith(quote)) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** 解析 .env 文本；同名键后者胜，保留首次出现的顺序 */
function parseEnvText(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const body = text.startsWith(BOM) ? text.slice(1) : text;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const statement = trimmed.replace(EXPORT_PREFIX, '');
    const eq = statement.indexOf('=');
    if (eq < 0) continue; // 没有等号：忽略，不报错

    const key = statement.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue; // KEY 非法：忽略

    entries.set(key, normalizeValue(statement.slice(eq + 1).trim()));
  }

  return entries;
}

/**
 * 加载 .env 并写入目标环境。
 *
 * 任何读取/解析失败都按「没有文件」处理：返回 path=null 且 loaded 为空，不抛错。
 */
export async function loadEnv(options: LoadEnvOptions = {}): Promise<EnvLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const filePath = path.resolve(cwd, options.filename ?? ENV_FILE_NAME);

  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return { path: null, loaded: [], skipped: [] };
  }

  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of parseEnvText(text)) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    loaded.push(key);
  }

  return { path: filePath, loaded, skipped };
}
