/**
 * calculator 安全解析测试：只认 + - * / 与括号，绝不执行任意代码。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CalculatorError,
  calculatorHandler,
  evaluateExpression,
  formatNumber,
} from '../src/tools/calculator.js';

const context = { toolName: 'calculator' };

describe('calculator：合法表达式', () => {
  const cases: Array<[string, number]> = [
    ['1+1', 2],
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 / 4', 2.5],
    ['-3 + 2', -1],
    ['--3', 3],
    ['2 * (3 + 4) - 5 / 2', 11.5],
    ['.5 + .25', 0.75],
    ['  7  ', 7],
    ['((2))', 2],
  ];

  for (const [expression, expected] of cases) {
    it(`${expression} = ${expected}`, () => {
      assert.equal(evaluateExpression(expression), expected);
    });
  }
});

describe('calculator：非法输入', () => {
  const bad = [
    '',
    '   ',
    '1 +',
    '(1 + 2',
    '1 + 2)',
    '1 / 0',
    '2 ** 3',
    'abc',
    '1 + x',
    '1..2',
    'eval("1+1")',
    'process.exit()',
    '1; 2',
  ];

  for (const expression of bad) {
    it(`拒绝 ${JSON.stringify(expression)}`, () => {
      assert.throws(() => evaluateExpression(expression), CalculatorError);
    });
  }

  it('拒绝超长表达式', () => {
    assert.throws(() => evaluateExpression('1+'.repeat(400) + '1'), CalculatorError);
  });
});

describe('calculator：格式化与工具入口', () => {
  it('整数不带小数点，小数去掉多余的 0', () => {
    assert.equal(formatNumber(4), '4');
    assert.equal(formatNumber(2.5), '2.5');
    assert.equal(formatNumber(1 / 3), '0.3333333333');
  });

  it('handler 返回可读文本', async () => {
    const output = await calculatorHandler({ expression: '(1 + 2) * 3' }, context);
    assert.equal(output, '(1 + 2) * 3 = 9');
  });

  it('handler 缺少 expression 时抛错（由 registry 兜底）', async () => {
    await assert.rejects(() => calculatorHandler({}, context), CalculatorError);
  });
});
