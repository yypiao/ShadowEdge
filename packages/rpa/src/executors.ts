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

export function nodeError(node: RpaNode, message: string): ShadowEdgeError {
  return new ShadowEdgeError('E_RPA_NODE_FAILED', `节点 ${node.id}: ${message}`, {
    details: { nodeId: node.id, kind: node.kind },
  });
}

export function interpolate(value: string, execution: RpaNodeExecution): string {
  return value.replace(
    /\{\{\s*(inputs|outputs|loop)\.([\w-]+)(?:\.(index))?\s*\}\}/g,
    (_match, namespace: string, key: string, suffix: string | undefined) => {
      if (namespace === 'loop') {
        if (suffix !== 'index' || execution.loopIndices[key] === undefined) {
          throw nodeError(execution.node, `loop.${key}.index 不在有效循环作用域内`);
        }
        return String(execution.loopIndices[key]);
      }
      const source = namespace === 'inputs' ? execution.inputs : execution.outputs;
      const resolved = source[key];
      if (resolved === undefined || (resolved !== null && typeof resolved !== 'string' &&
        typeof resolved !== 'number' && typeof resolved !== 'boolean')) {
        throw nodeError(execution.node, `${namespace}.${key} 必须是已产生的字符串、数字或布尔值`);
      }
      return resolved === null ? '' : String(resolved);
    },
  );
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

function nodeTimeout(execution: RpaNodeExecution, requested: number): number {
  throwIfCancelled(execution.signal);
  const remaining = execution.deadlineAt - Date.now();
  if (remaining <= 0) throw new ShadowEdgeError('E_RPA_CANCELLED', 'RPA 运行已超过总截止时间');
  return Math.max(1, Math.min(requested, remaining));
}

function targetLocator(execution: RpaNodeExecution) {
  const selector = requiredString(execution, 'selector');
  const frameSelector = execution.node.params.frameSelector;
  const frameSelectors = execution.node.params.frameSelectors;
  if (frameSelector !== undefined && frameSelectors !== undefined) {
    throw nodeError(execution.node, 'frameSelector 与 frameSelectors 不能同时配置');
  }
  if (frameSelectors !== undefined) {
    if (!Array.isArray(frameSelectors) || frameSelectors.length < 1 || frameSelectors.length > 8 ||
      !frameSelectors.every((value) => typeof value === 'string' && value.length > 0)) {
      throw nodeError(execution.node, 'frameSelectors 必须是 1..8 个非空字符串');
    }
    let frame = execution.page.frameLocator(frameSelectors[0]!);
    for (const nested of frameSelectors.slice(1)) frame = frame.frameLocator(nested);
    return frame.locator(selector);
  }
  if (frameSelector === undefined) return execution.page.locator(selector);
  if (typeof frameSelector !== 'string' || frameSelector.length === 0) {
    throw nodeError(execution.node, 'frameSelector 必须是非空字符串');
  }
  // Patchright CSS locator 默认穿透开放 Shadow DOM；Iframe 则必须显式限定 frame。
  return execution.page.frameLocator(frameSelector).locator(selector);
}

async function navigateCurrentPage(execution: RpaNodeExecution, url: string): Promise<void> {
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
    timeout: nodeTimeout(execution, optionalNumber(execution, 'timeout', 15000)),
  });
}

const navigate: RpaNodeExecutor = async (execution) => {
  await navigateCurrentPage(execution, requiredString(execution, 'url'));
};

async function clickTarget(execution: RpaNodeExecution, locator: ReturnType<typeof targetLocator>): Promise<void> {
  await locator.waitFor({
    state: 'visible',
    timeout: nodeTimeout(execution, optionalNumber(execution, 'timeout', 10000)),
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
}

const click: RpaNodeExecutor = async (execution) => {
  await clickTarget(execution, targetLocator(execution));
};

const type: RpaNodeExecutor = async (execution) => {
  const locator = targetLocator(execution);
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
  const locator = targetLocator(execution);
  const attribute = execution.node.params.attribute;
  if (attribute !== undefined && typeof attribute !== 'string') {
    throw nodeError(execution.node, 'attribute 必须是字符串');
  }
  const value = attribute ? await locator.getAttribute(attribute) : await locator.textContent();
  execution.outputs[requiredString(execution, 'key')] = value;
};

const screenshot: RpaNodeExecutor = async (execution) => {
  const key = artifactKey(execution);
  const path = execution.artifactPath(`${key}.png`);
  await execution.page.screenshot({
    path,
    fullPage: optionalBoolean(execution, 'fullPage', true),
    type: 'png',
  });
  chmodSync(path, 0o600);
  execution.run.artifacts.push({ kind: 'screenshot', uri: path });
};

const select: RpaNodeExecutor = async (execution) => {
  const locator = targetLocator(execution);
  const timeout = nodeTimeout(execution, optionalNumber(execution, 'timeout', 10000));
  await locator.waitFor({ state: 'visible', timeout });
  const values = execution.node.params.values;
  if (values !== undefined) {
    if (execution.node.params.value !== undefined || !Array.isArray(values) || values.length > 100 ||
      !values.every((value) => typeof value === 'string' && value.length <= 10000)) {
      throw nodeError(execution.node, 'values 必须是最多 100 个字符串，且不能与 value 同时配置');
    }
    await locator.selectOption(values, { timeout });
    return;
  }
  await locator.selectOption(requiredString(execution, 'value'), { timeout });
};

const check: RpaNodeExecutor = async (execution) => {
  const locator = targetLocator(execution);
  const timeout = nodeTimeout(execution, optionalNumber(execution, 'timeout', 10000));
  await locator.waitFor({ state: 'visible', timeout });
  await locator.setChecked(optionalBoolean(execution, 'checked', true), { timeout });
};

const upload: RpaNodeExecutor = async (execution) => {
  await targetLocator(execution).setInputFiles(requiredString(execution, 'path'), {
    timeout: nodeTimeout(execution, optionalNumber(execution, 'timeout', 10000)),
  });
};

function artifactKey(execution: RpaNodeExecution): string {
  const key = requiredString(execution, 'key');
  if (!/^[\w-]+$/.test(key)) throw nodeError(execution.node, 'key 只能包含字母、数字、下划线和连字符');
  return key;
}

const download: RpaNodeExecutor = async (execution) => {
  const timeout = nodeTimeout(execution, optionalNumber(execution, 'timeout', 30000));
  const [file] = await Promise.all([
    execution.page.waitForEvent('download', { timeout }),
    clickTarget(execution, targetLocator(execution)),
  ]);
  const key = artifactKey(execution);
  const suggested = file.suggestedFilename();
  const safeName = suggested.replace(/[^\w.-]/g, '_').replace(/^\.+/, '').slice(-120) || 'download.bin';
  const path = execution.artifactPath(`${key}-${safeName}`);
  await file.saveAs(path);
  chmodSync(path, 0o600);
  execution.outputs[key] = suggested;
  execution.run.artifacts.push({ kind: 'download', uri: path });
};

const newTab: RpaNodeExecutor = async (execution) => {
  execution.page = await execution.createPage();
  const rawUrl = execution.node.params.url;
  if (rawUrl === undefined) return;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) throw nodeError(execution.node, 'url 必须是非空字符串');
  await navigateCurrentPage(execution, interpolate(rawUrl, execution));
};

const switchTab: RpaNodeExecutor = async (execution) => {
  const index = execution.node.params.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw nodeError(execution.node, 'index 必须是非负整数');
  }
  const timeout = optionalNumber(execution, 'timeout', 0);
  if (timeout > 30000) throw nodeError(execution.node, 'timeout 不能超过 30000');
  const waitMs = nodeTimeout(execution, timeout);
  const deadline = Date.now() + waitMs;
  while (true) {
    throwIfCancelled(execution.signal);
    const pages = execution.listPages();
    const selected = pages[index];
    if (selected) {
      await selected.bringToFront();
      execution.page = selected;
      return;
    }
    if (Date.now() >= deadline || timeout === 0) {
      throw nodeError(execution.node, `标签页索引 ${index} 不存在，当前共 ${pages.length} 页`);
    }
    await abortableDelay(Math.min(50, deadline - Date.now()), execution.signal);
  }
};

const closeTab: RpaNodeExecutor = async (execution) => {
  const index = execution.node.params.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw nodeError(execution.node, 'index 必须是非负整数');
  }
  const pages = execution.listPages();
  const selected = pages[index];
  if (!selected) throw nodeError(execution.node, `标签页索引 ${index} 不存在，当前共 ${pages.length} 页`);
  const closingCurrent = selected === execution.page;
  await selected.close();
  if (closingCurrent) {
    const remaining = execution.listPages();
    const fallback = remaining[Math.min(index, remaining.length - 1)];
    if (fallback) {
      await fallback.bringToFront();
      execution.page = fallback;
    }
  }
};

export const nodeExecutors: ReadonlyMap<RpaNodeKind, RpaNodeExecutor> = new Map([
  ['navigate', navigate],
  ['click', click],
  ['type', type],
  ['wait', wait],
  ['extract', extract],
  ['screenshot', screenshot],
  ['select', select],
  ['check', check],
  ['upload', upload],
  ['download', download],
  ['newTab', newTab],
  ['switchTab', switchTab],
  ['closeTab', closeTab],
]);
