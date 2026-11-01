import { chmodSync } from 'node:fs';
import { ShadowEdgeError } from '@shadowedge/core';
import type { RpaNode, RpaNodeKind } from '@shadowedge/core';
import type { RpaNodeExecution, RpaNodeExecutor, RpaPage } from './session.js';

const mousePositions = new WeakMap<RpaPage, { x: number; y: number }>();

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ShadowEdgeError('E_RPA_CANCELLED', 'RPA 运行已取消', { retryable: false });
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ShadowEdgeError('E_RPA_CANCELLED', 'RPA 运行已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function nodeError(node: RpaNode, message: string): ShadowEdgeError {
  return new ShadowEdgeError('E_RPA_NODE_FAILED', `节点 ${node.id}: ${message}`, {
    details: { nodeId: node.id, kind: node.kind },
  });
}

function interpolate(value: string, execution: RpaNodeExecution): string {
  return value.replace(/\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (_match, key: string) => {
    const input = execution.inputs[key];
    if (typeof input !== 'string' && typeof input !== 'number' && typeof input !== 'boolean') {
      throw nodeError(execution.node, `inputs.${key} 必须是字符串、数字或布尔值`);
    }
    return String(input);
  });
}

function requiredString(execution: RpaNodeExecution, key: string): string {
  const value = execution.node.params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw nodeError(execution.node, `${key} 必须是非空字符串`);
  }
  return interpolate(value, execution);
}

function optionalNumber(execution: RpaNodeExecution, key: string, fallback: number): number {
  const value = execution.node.params[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw nodeError(execution.node, `${key} 必须是非负数字`);
  }
  return value;
}

function optionalBoolean(execution: RpaNodeExecution, key: string, fallback: boolean): boolean {
  const value = execution.node.params[key] ?? fallback;
  if (typeof value !== 'boolean') throw nodeError(execution.node, `${key} 必须是布尔值`);
  return value;
}

const navigate: RpaNodeExecutor = async (execution) => {
  const url = requiredString(execution, 'url');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw nodeError(execution.node, 'url 仅允许 http/https');
  }
  const waitUntil = execution.node.params.waitUntil ?? 'domcontentloaded';
  if (waitUntil !== 'load' && waitUntil !== 'domcontentloaded' && waitUntil !== 'networkidle') {
    throw nodeError(execution.node, 'waitUntil 无效');
  }
  await execution.page.goto(url, {
    waitUntil,
    timeout: optionalNumber(execution, 'timeout', 15000),
  });
};

const click: RpaNodeExecutor = async (execution) => {
  const locator = execution.page.locator(requiredString(execution, 'selector'));
  await locator.waitFor({
    state: 'visible',
    timeout: optionalNumber(execution, 'timeout', 10000),
  });
  const box = await locator.boundingBox();
  if (!box) throw nodeError(execution.node, '元素没有可点击区域');
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const start = mousePositions.get(execution.page) ?? { x: 0, y: 0 };
  const control = {
    x: (start.x + target.x) / 2 + (execution.random() - 0.5) * 160,
    y: (start.y + target.y) / 2 + (execution.random() - 0.5) * 160,
  };
  for (let step = 1; step <= 16; step += 1) {
    throwIfCancelled(execution.signal);
    const t = step / 16;
    const inverse = 1 - t;
    await execution.page.mouse.move(
      inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * target.x,
      inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * target.y,
    );
    await abortableDelay(8 + Math.floor(execution.random() * 12), execution.signal);
  }
  await execution.page.mouse.click(target.x, target.y);
  mousePositions.set(execution.page, target);
};

const type: RpaNodeExecutor = async (execution) => {
  const locator = execution.page.locator(requiredString(execution, 'selector'));
  const text = requiredString(execution, 'text');
  if (optionalBoolean(execution, 'clear', true)) await locator.fill('');
  for (const character of text) {
    throwIfCancelled(execution.signal);
    await locator.pressSequentially(character, { delay: 0 });
    await abortableDelay(80 + Math.floor(execution.random() * 181), execution.signal);
  }
};

const wait: RpaNodeExecutor = async (execution) => {
  const ms = optionalNumber(execution, 'ms', 1000);
  if (ms > 300000) throw nodeError(execution.node, 'ms 不能超过 300000');
  await abortableDelay(ms, execution.signal);
};

const extract: RpaNodeExecutor = async (execution) => {
  const locator = execution.page.locator(requiredString(execution, 'selector'));
  const attribute = execution.node.params.attribute;
  if (attribute !== undefined && typeof attribute !== 'string') {
    throw nodeError(execution.node, 'attribute 必须是字符串');
  }
  const value = attribute ? await locator.getAttribute(attribute) : await locator.textContent();
  execution.outputs[requiredString(execution, 'key')] = value;
};

const screenshot: RpaNodeExecutor = async (execution) => {
  const key = requiredString(execution, 'key');
  if (!/^[\w-]+$/.test(key))
    throw nodeError(execution.node, 'key 只能包含字母、数字、下划线和连字符');
  const path = execution.artifactPath(`${key}.png`);
  await execution.page.screenshot({
    path,
    fullPage: optionalBoolean(execution, 'fullPage', true),
    type: 'png',
  });
  chmodSync(path, 0o600);
  execution.run.artifacts.push({ kind: 'screenshot', uri: path });
};

export const nodeExecutors: ReadonlyMap<RpaNodeKind, RpaNodeExecutor> = new Map([
  ['navigate', navigate],
  ['click', click],
  ['type', type],
  ['wait', wait],
  ['extract', extract],
  ['screenshot', screenshot],
]);
