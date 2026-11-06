/**
 * todo 工具：进程内内存版待办清单，支持 add / list / done。
 *
 * 一句话功能：维护一份进程内的待办清单，供 agent 记录与勾选计划项。
 * 参数：action（add/list/done 必填）；add 需要 text；done 需要 id。
 * 返回：JSON 文本，含 message 与条目/列表（add、done 返回单条，list 返回全部）。
 * 失败情况：action 缺失或未知、add 缺 text、done 缺 id 或编号不存在，均返回 ok=false。
 *
 * 用工厂函数创建，每个 registry 实例持有独立状态；同一实例内部再按
 * ctx.sessionId 分区，A 会话的待办不会出现在 B 会话的 list 里
 * （没给 sessionId 时落在默认分区 ''，即 CLI/单会话的旧行为）。
 * 状态不落盘：本阶段只验证工具协议与 session 隔离，持久化留给记忆层。
 */

import type { ToolSpec } from '../types.js';
import { defineTool, toolOk } from './base.js';
import type { Tool } from './base.js';
import type { ToolContext } from './base.js';

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface TodoTool {
  /** defineTool 产物，交给 registry.register */
  tool: Tool;
  /** 只读快照，测试与调试用；不传 sessionId 时取默认分区 */
  snapshot: (sessionId?: string) => TodoItem[];
}

function requireText(args: Record<string, unknown>): string {
  const text = args['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('add 操作需要非空字符串参数 text');
  }
  return text.trim();
}

function requireId(args: Record<string, unknown>): number {
  const raw = args['id'];
  const id = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('done 操作需要正整数参数 id，可先用 list 查看编号');
  }
  return id;
}

export function createTodoTool(): TodoTool {
  /** key = ctx.sessionId ?? ''；每个分区独立的 items 与自增编号 */
  const partitions = new Map<string, { items: TodoItem[]; nextId: number }>();

  const partitionFor = (sessionId: string | undefined): { items: TodoItem[]; nextId: number } => {
    const key = sessionId ?? '';
    let partition = partitions.get(key);
    if (!partition) {
      partition = { items: [], nextId: 1 };
      partitions.set(key, partition);
    }
    return partition;
  };

  const spec: ToolSpec = {
    name: 'todo',
    description: '内存待办清单，支持 action=add（新增，需 text）、list（列出全部）、done（标记完成，需 id）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'done'],
          description: '要执行的操作',
        },
        text: {
          type: 'string',
          description: 'action=add 时的待办内容',
        },
        id: {
          type: 'integer',
          description: 'action=done 时的待办编号',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };

  const handle = async (args: Record<string, unknown>, context: ToolContext): Promise<unknown> => {
    const action = args['action'];
    const partition = partitionFor(context.sessionId);
    const items = partition.items;

    if (action === 'add') {
      const text = requireText(args);
      const item: TodoItem = { id: partition.nextId++, text, done: false, createdAt: Date.now() };
      items.push(item);
      return { message: `已添加 #${item.id}: ${item.text}`, item };
    }

    if (action === 'list') {
      return {
        count: items.length,
        items: items.map((item) => ({ ...item })),
        message: items.length === 0 ? '待办列表为空' : `共 ${items.length} 条待办`,
      };
    }

    if (action === 'done') {
      const id = requireId(args);
      const target = items.find((item) => item.id === id);
      if (!target) throw new Error(`找不到编号为 ${id} 的待办`);
      target.done = true;
      return { message: `已标记 #${target.id} 完成：${target.text}`, item: { ...target } };
    }

    throw new Error(`未知 action：${String(action)}，仅支持 add / list / done`);
  };

  const tool = defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    todo: [
      '维护进程内的待办清单：新增条目、列出全部、把某条标记完成。',
      '第一步：读取 action，只接受 add / list / done，其余直接失败。',
      '第二步：add 要求 text 非空，分配自增编号后入库；done 要求正整数 id 且编号存在。',
      '边界：状态只存在当前进程内，重启即丢失；待办按会话隔离，不同 session 的清单互不可见。',
      '失败情况：action 缺失或未知、add 缺 text、done 缺 id 或编号不存在，均返回 ok=false。',
    ],
    async run(args, ctx) {
      const payload = await handle(args, ctx);
      return toolOk(JSON.stringify(payload), payload);
    },
  });

  return {
    tool,
    snapshot: (sessionId?: string) => {
      const partition = partitions.get(sessionId ?? '');
      return partition ? partition.items.map((item) => ({ ...item })) : [];
    },
  };
}
