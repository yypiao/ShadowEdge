import type { RpaNode } from '@shadowedge/core';
import { interpolate, nodeError } from './executors.js';
import type { RpaNodeExecution } from './session.js';

export function nextForCondition(node: RpaNode, execution: RpaNodeExecution): string | undefined {
  const operator = String(node.params.operator ?? 'equals');
  const left = conditionLeft(String(node.params.left ?? ''), operator, node, execution);
  const rawRight = node.params.right;
  const right = typeof rawRight === 'string' ? interpolate(rawRight, execution) : String(rawRight ?? '');
  switch (operator) {
    case 'equals': return left === right ? node.next : node.elseNext;
    case 'notEquals': return left !== right ? node.next : node.elseNext;
    case 'contains': return left.includes(right) ? node.next : node.elseNext;
    case 'notContains': return !left.includes(right) ? node.next : node.elseNext;
    case 'exists': return left.length > 0 ? node.next : node.elseNext;
    case 'notExists': return left.length === 0 ? node.next : node.elseNext;
    case 'greaterThan': return numeric(left, right, node, execution) > 0 ? node.next : node.elseNext;
    case 'lessThan': return numeric(left, right, node, execution) < 0 ? node.next : node.elseNext;
    default: throw nodeError(node, `不支持的条件运算符 ${operator}`);
  }
}

function conditionLeft(
  raw: string,
  operator: string,
  node: RpaNode,
  execution: RpaNodeExecution,
): string {
  if (operator !== 'exists' && operator !== 'notExists') return interpolate(raw, execution);
  const variable = raw.match(/^\{\{\s*(inputs|outputs)\.([\w-]+)\s*\}\}$/);
  if (!variable) return interpolate(raw, execution);
  const source = variable[1] === 'inputs' ? execution.inputs : execution.outputs;
  const value = source[variable[2]!];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw nodeError(node, `${variable[1]}.${variable[2]} 必须是字符串、数字或布尔值`);
  }
  return String(value);
}

export function loopCount(node: RpaNode, execution: RpaNodeExecution): number {
  const raw = node.params.count;
  const value = typeof raw === 'string' ? interpolate(raw, execution) : raw;
  if (typeof value !== 'number' && typeof value !== 'string') throw nodeError(node, 'count 必须是整数或变量表达式');
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw nodeError(node, 'count 必须是 0..1000 的整数');
  return count;
}

function numeric(left: string, right: string, node: RpaNode, execution: RpaNodeExecution): number {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw nodeError(execution.node, '数值比较的左右两侧必须是有限数字');
  return a - b;
}
