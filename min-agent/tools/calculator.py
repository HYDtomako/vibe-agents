"""Arithmetic with an AST whitelist. Names, calls, and imports never run."""

from __future__ import annotations

import ast
import operator
from typing import Any

from tools.registry import Tool, object_schema

_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
_MAX_EXPRESSION_LENGTH = 200
_MAX_ABS_EXPONENT = 32


def calculate(expression: str) -> dict[str, Any]:
    if not isinstance(expression, str):
        raise ValueError("expression must be a string")
    text = expression.strip()
    if not text:
        raise ValueError("expression is required")
    if len(text) > _MAX_EXPRESSION_LENGTH:
        raise ValueError("expression is too long")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise ValueError("invalid expression") from exc
    try:
        result = _fold(tree.body)
    except ZeroDivisionError as exc:
        raise ValueError("division by zero") from exc
    return {"expression": text, "result": result}


def _fold(node: ast.AST) -> int | float:
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return node.value
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_fold(node.operand))
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        left = _fold(node.left)
        right = _fold(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > _MAX_ABS_EXPONENT:
            raise ValueError("exponent too large")
        return _BINOPS[type(node.op)](left, right)
    raise ValueError("only numbers and + - * / // % ** are allowed")


CALCULATOR = Tool(
    name="calculator",
    description=(
        "Evaluate one arithmetic expression. "
        "Allowed: numbers, parentheses, and + - * / // % **. "
        "No names, attributes, or function calls."
    ),
    parameters=object_schema(
        {
            "expression": {
                "type": "string",
                "description": "Expression such as (2 + 3) * 4",
            }
        },
        ["expression"],
    ),
    handler=calculate,
)
