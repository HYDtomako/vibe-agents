/**
 * calculator 工具：只支持 + - * / 与括号的整数/小数四则运算。
 *
 * 一句话功能：安全求值一个四则运算表达式，不执行任何代码。
 * 参数：expression——非空字符串，长度 ≤ 500，只允许数字、+ - * / 与括号。
 * 返回：`<原表达式> = <结果>` 的可读文本；整数不带小数点，小数去掉尾随 0。
 * 失败情况：表达式为空/过长/含非法字符/括号不匹配或嵌套超过 50 层/除数为 0/
 *          结果非有限数，均抛 CalculatorError，由 registry 折算成 ok=false。
 *
 * 不使用 eval / new Function：手写词法分析 + 递归下降解析，天然杜绝代码注入。
 * 文法：
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/') unary)*
 *   unary      := '-' unary | primary
 *   primary    := number | '(' expression ')'
 */

import type { ToolSpec } from '../types.js';
import { defineTool, toolOk } from './base.js';
import type { ToolContext } from './base.js';

/** 表达式非法时抛出，由 registry 统一转成 ok=false 的工具结果 */
export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorError';
  }
}

/** 表达式长度上限，防抖动的超长输入拖垮解析 */
const MAX_EXPRESSION_LENGTH = 500;
/** 括号嵌套上限 */
const MAX_DEPTH = 50;

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'operator'; value: '+' | '-' | '*' | '/' | '(' | ')' };

const OPERATORS = new Set(['+', '-', '*', '/', '(', ')']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index]!;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: 'operator', value: char as '+' | '-' | '*' | '/' | '(' | ')' });
      index += 1;
      continue;
    }

    if ((char >= '0' && char <= '9') || char === '.') {
      const start = index;
      while (index < input.length) {
        const current = input[index]!;
        if ((current >= '0' && current <= '9') || current === '.') index += 1;
        else break;
      }
      const raw = input.slice(start, index);
      // 只接受 12 / 12.5 / .5 这三种形态，拒绝 1.2.3、12. 等可疑输入
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) {
        throw new CalculatorError(`非法数字：${raw}`);
      }
      tokens.push({ kind: 'number', value: Number(raw) });
      continue;
    }

    throw new CalculatorError(`非法字符：${char}`);
  }

  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) throw new CalculatorError('表达式为空');
    const value = this.parseExpression();
    if (this.position !== this.tokens.length) {
      throw new CalculatorError('表达式存在无法解析的剩余内容');
    }
    return value;
  }

  private peekOperator(): string | undefined {
    const token = this.tokens[this.position];
    return token && token.kind === 'operator' ? token.value : undefined;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const operator = this.peekOperator();
      if (operator !== '+' && operator !== '-') return value;
      this.position += 1;
      const right = this.parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    for (;;) {
      const operator = this.peekOperator();
      if (operator !== '*' && operator !== '/') return value;
      this.position += 1;
      const right = this.parseUnary();
      if (operator === '/') {
        if (right === 0) throw new CalculatorError('除数不能为 0');
        value = value / right;
      } else {
        value = value * right;
      }
    }
  }

  private parseUnary(): number {
    if (this.peekOperator() === '-') {
      this.position += 1;
      return -this.parseUnary();
    }
    if (this.peekOperator() === '+') {
      this.position += 1;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.tokens[this.position];
    if (!token) throw new CalculatorError('表达式意外结束');

    if (token.kind === 'number') {
      this.position += 1;
      return token.value;
    }

    if (token.value === '(') {
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new CalculatorError('括号嵌套过深');
      this.position += 1;
      const value = this.parseExpression();
      const closing = this.tokens[this.position];
      if (!closing || closing.kind !== 'operator' || closing.value !== ')') {
        throw new CalculatorError('括号不匹配');
      }
      this.position += 1;
      this.depth -= 1;
      return value;
    }

    throw new CalculatorError(`意外的符号：${token.value}`);
  }
}

/** 计算表达式并返回数值；非法表达式/除零/非有限结果都抛 CalculatorError */
export function evaluateExpression(expression: string): number {
  if (typeof expression !== 'string') throw new CalculatorError('expression 必须是字符串');
  const trimmed = expression.trim();
  if (trimmed === '') throw new CalculatorError('expression 不能为空');
  if (trimmed.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculatorError(`expression 过长（上限 ${MAX_EXPRESSION_LENGTH} 字符）`);
  }

  const value = new Parser(tokenize(trimmed)).parse();
  if (!Number.isFinite(value)) throw new CalculatorError('计算结果不是有限数值');
  return value;
}

/** 结果格式化：整数直接输出，小数保留至多 10 位并去掉尾随 0 */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

export const calculatorSpec: ToolSpec = {
  name: 'calculator',
  description:
    '计算四则运算表达式，仅支持 + - * / 和括号，例如 "(1 + 2) * 3 / 4"。不执行任何代码。',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '待计算的表达式，例如 "(1+2)*3"',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
};

/** 工具入口：返回可读文本，非法输入抛错交给 registry 兜底 */
export async function calculatorHandler(
  args: Record<string, unknown>,
  _context: ToolContext,
): Promise<string> {
  const expression = args['expression'];
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new CalculatorError('缺少字符串参数 expression');
  }
  const value = evaluateExpression(expression);
  return `${expression.trim()} = ${formatNumber(value)}`;
}

/** defineTool 形态的 calculator；失败靠抛错交给 registry 兜底 */
export const calculatorTool = defineTool({
  name: calculatorSpec.name,
  description: calculatorSpec.description,
  parameters: calculatorSpec.parameters,
  todo: [
    '用一个安全的四则运算求值器计算用户给出的表达式，替代不可靠的心算。',
    '第一步：确认 expression 是非空字符串，长度不超过 500 字符。',
    '第二步：词法分析，只接受数字、+ - * / 和括号，其他字符立即判为非法。',
    '第三步：递归下降求值，括号嵌套超过 50 层直接失败。',
    '边界：只支持四则运算，不支持幂、取模、函数、常量；不做单位换算。',
    '失败情况：表达式为空、含非法字符、括号不匹配、除数为 0、结果非有限数，均返回 ok=false。',
  ],
  async run(args, ctx) {
    const output = await calculatorHandler(args, ctx);
    return toolOk(output);
  },
});
