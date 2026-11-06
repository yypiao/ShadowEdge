import type { RpaNode, RpaRun } from '@shadowedge/core';

/** 最小结构接口：Patchright Page/Locator 天然满足，也便于无浏览器单元测试。 */
export interface RpaLocator {
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  fill(value: string): Promise<void>;
  pressSequentially(value: string, options: { delay: number }): Promise<void>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  selectOption(value: string | string[], options: { timeout: number }): Promise<string[]>;
  setChecked(checked: boolean, options: { timeout: number }): Promise<void>;
  setInputFiles(files: string, options: { timeout: number }): Promise<void>;
}

export interface RpaFrameLocator {
  locator(selector: string): RpaLocator;
  frameLocator(selector: string): RpaFrameLocator;
}

export interface RpaMouse {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
}

export interface RpaDownload {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

export interface RpaPage {
  mouse: RpaMouse;
  goto(
    url: string,
    options: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number },
  ): Promise<unknown>;
  locator(selector: string): RpaLocator;
  frameLocator(selector: string): RpaFrameLocator;
  screenshot(options: { path: string; fullPage: boolean; type: 'png' }): Promise<Uint8Array>;
  bringToFront(): Promise<void>;
  waitForEvent(event: 'download', options: { timeout: number }): Promise<RpaDownload>;
  /** 硬取消时关闭当前 RPA 页面，使未结束的 CDP 调用失败并落定。 */
  close(): Promise<void>;
}

export interface RpaBrowserContext {
  pages(): RpaPage[];
  newPage(): Promise<RpaPage>;
}

export interface RpaNodeExecution {
  run: RpaRun;
  node: RpaNode;
  page: RpaPage;
  inputs: Record<string, unknown>;
  signal: AbortSignal;
  /** 整个工作流的绝对截止时间，节点自身 timeout 不得越过它。 */
  deadlineAt: number;
  closePage(): Promise<void>;
  createPage(): Promise<RpaPage>;
  listPages(): RpaPage[];
  percent: number;
  random: () => number;
  outputs: Record<string, string | null>;
  /** key 为 loop 节点 id，value 从 0 开始。 */
  loopIndices: Record<string, number>;
  artifactPath(fileName: string): string;
}

export type RpaNodeExecutor = (execution: RpaNodeExecution) => Promise<void>;
