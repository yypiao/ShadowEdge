import type { RpaNode, RpaRun } from '@shadowedge/core';

/** 最小结构接口：Patchright Page/Locator 天然满足，也便于无浏览器单元测试。 */
export interface RpaLocator {
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  fill(value: string): Promise<void>;
  pressSequentially(value: string, options: { delay: number }): Promise<void>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
}

export interface RpaMouse {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
}

export interface RpaPage {
  mouse: RpaMouse;
  goto(
    url: string,
    options: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number },
  ): Promise<unknown>;
  locator(selector: string): RpaLocator;
  screenshot(options: { path: string; fullPage: boolean; type: 'png' }): Promise<Uint8Array>;
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
  percent: number;
  random: () => number;
  outputs: Record<string, string | null>;
  artifactPath(fileName: string): string;
}

export type RpaNodeExecutor = (execution: RpaNodeExecution) => Promise<void>;
