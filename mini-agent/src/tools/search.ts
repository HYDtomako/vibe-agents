/**
 * search 工具：用固定假数据模拟检索，不访问网络。
 *
 * 一句话功能：在内置 mock 知识库里做关键词检索，返回标题、摘要与匹配分数。
 * 参数：query（非空字符串，空格分隔多关键词）、limit（返回条数，默认 3，最大 10）。
 * 返回：JSON 文本 { query, total, results[], message }，results 每项含 id/title/snippet/score。
 * 失败情况：query 缺失或为空字符串时返回 ok=false；无命中时返回空列表（不算失败）。
 *
 * 目的只是验证「模型发起检索 -> 工具返回结构化结果 -> 结果回灌」这条链路，
 * 真实检索（向量/BM25）属于下一阶段。
 */

import type { ToolSpec } from '../types.js';
import { defineTool, toolFail, toolOk } from './base.js';
import type { ToolContext } from './base.js';

interface SearchDoc {
  id: string;
  title: string;
  content: string;
  tags: string[];
}

/** 固定假数据：内容与 agent runtime 相关，便于人工核对结果是否合理 */
const DOCS: readonly SearchDoc[] = [
  {
    id: 'doc-1',
    title: 'Agent Loop 的基本形态',
    content:
      '一个最小 agent loop 由四步构成：接收用户输入、请求模型判断直接回答还是调用工具、执行工具、把结果回灌给模型继续循环。终止条件是模型不再发起工具调用，或达到 maxTurns 上限。',
    tags: ['agent', 'loop', 'runtime'],
  },
  {
    id: 'doc-2',
    title: '为什么工具调用结果要结构化回灌',
    content:
      '工具执行失败时如果直接抛异常，整个循环会中断。更稳妥的做法是把 { ok, output } 作为 tool 消息回灌，让模型自行决定重试、换参数或向用户解释失败原因。',
    tags: ['tool', 'error-handling', 'robustness'],
  },
  {
    id: 'doc-3',
    title: 'Trace 该记什么',
    content:
      '每轮记录轮次编号、模型返回的 usage、工具名与参数、结果摘要以及耗时毫秒数。Trace 既是调试手段，也是评估 agent 行为成本与稳定性的基础数据。',
    tags: ['trace', 'observability', 'usage'],
  },
  {
    id: 'doc-4',
    title: 'Context 压缩的常见策略',
    content:
      '当历史消息超出上下文预算时，可以保留 system 提示与最近若干轮对话，把更早的轮次摘要成一条 assistant 消息；也可按 token 预算裁剪最早的工具结果。',
    tags: ['context', 'compression', 'token'],
  },
  {
    id: 'doc-5',
    title: '多 Session 隔离的要点',
    content:
      'session 隔离要求消息历史、工具状态、trace 都按会话归档，并用显式 sessionId 贯穿 loop、registry 与 logger，避免不同用户的数据互相污染。',
    tags: ['session', 'isolation', 'multi-tenant'],
  },
  {
    id: 'doc-6',
    title: '模型适配层的边界',
    content:
      '适配层只负责协议转换、超时、错误归一化与 usage 透传，不承担业务逻辑。这样替换 provider 时，agent loop 与工具层无需改动。',
    tags: ['model', 'adapter', 'provider'],
  },
];

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
}

/** 简单加权打分：标题 x3、标签 x2、正文 x1，够用且可解释 */
export function searchDocs(query: string, limit = 3): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  if (terms.length === 0) return [];

  const scored: SearchHit[] = [];
  for (const doc of DOCS) {
    const title = doc.title.toLowerCase();
    const content = doc.content.toLowerCase();
    const tags = doc.tags.join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 3;
      if (tags.includes(term)) score += 2;
      if (content.includes(term)) score += 1;
    }

    if (score > 0) {
      const firstTerm = terms[0]!;
      const position = content.indexOf(firstTerm);
      const start = position > 20 ? position - 20 : 0;
      scored.push({
        id: doc.id,
        title: doc.title,
        snippet: doc.content.slice(start, start + 80),
        score,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export const searchSpec: ToolSpec = {
  name: 'search',
  description: '检索内置的固定知识库（mock 数据，不访问网络），返回标题、摘要与匹配分数。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索关键词，多个关键词用空格分隔',
      },
      limit: {
        type: 'integer',
        description: '返回条数上限，默认 3，最大 10',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export async function searchHandler(
  args: Record<string, unknown>,
  _context: ToolContext,
): Promise<unknown> {
  const query = args['query'];
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('缺少非空字符串参数 query');
  }

  const rawLimit = args['limit'];
  const parsedLimit = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 10) : 3;

  const hits = searchDocs(query, limit);
  return {
    query: query.trim(),
    total: hits.length,
    results: hits,
    message: hits.length === 0 ? '内置知识库中没有匹配结果（mock 数据）' : `命中 ${hits.length} 条（mock 数据）`,
  };
}

/** defineTool 形态的 search */
export const searchTool = defineTool({
  name: searchSpec.name,
  description: searchSpec.description,
  parameters: searchSpec.parameters,
  todo: [
    '在内置的固定 mock 知识库中按关键词检索，用于演示检索链路，不访问网络。',
    '第一步：校验 query 非空，多个关键词用空格分隔。',
    '第二步：按标题 x3、标签 x2、正文 x1 加权统计命中的关键词数。',
    '第三步：按分数倒序取前 limit 条（默认 3，上限 10），返回摘要片段。',
    '边界：知识库是硬编码的 6 篇文档，覆盖不了真实问题；不联网、不做语义匹配。',
    '失败情况：query 缺失或为空时返回 ok=false；无命中时返回 total=0 的空列表。',
  ],
  async run(args, ctx) {
    try {
      const payload = await searchHandler(args, ctx);
      return toolOk(JSON.stringify(payload), payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 检索是本地 mock，没有网络失败；参数类失败一律确定性失败，不重试
      return toolFail(`检索失败：${reason}`, 'SEARCH_FAILED', false);
    }
  },
});
