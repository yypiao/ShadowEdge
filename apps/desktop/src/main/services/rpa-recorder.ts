import { randomUUID } from 'node:crypto';
import { ShadowEdgeError } from '@shadowedge/core';
import type {
  RpaRecordedAction,
  RpaRecordingResult,
  RpaRecordingState,
  Uuid,
} from '@shadowedge/core';
import type { BrowserKernel } from '@shadowedge/kernel';
import { buildRecordedGraph } from '@shadowedge/rpa';
import type { BrowserContext, Disposable, Frame, Page } from 'patchright';
import { recordingScript, stableElementSelector } from './rpa-recording-script.js';

const MAX_ACTIONS = 500;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_TEXT_LENGTH = 10000;
const MAX_SELECT_VALUES = 100;

interface RecordingPage {
  page: Page;
  onFrameNavigated: (frame: Frame) => void;
  onClose: () => void;
}

interface RecordingSession {
  context: BrowserContext;
  bindingName: string;
  cleanupKey: string;
  frameTokenKey: string;
  binding?: Disposable;
  initScript?: Disposable;
  currentPage: Page;
  pages: Map<Page, RecordingPage>;
  /** 与 closeTab 执行器一致，页面关闭后立即压缩索引。 */
  pageOrder: Page[];
  actions: RpaRecordedAction[];
  ignoredPasswordSelectors: Set<string>;
  droppedActions: number;
  active: boolean;
  queue: Promise<void>;
  onContextPage: (page: Page) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStartUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ShadowEdgeError('E_RPA_INVALID_INPUT', '录制起始 URL 无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ShadowEdgeError('E_RPA_INVALID_INPUT', '录制起始 URL 仅允许 http/https');
  }
  return parsed.toString();
}

function validSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SELECTOR_LENGTH;
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function validSelectors(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 5 && value.every(validSelector);
}

function validSelectValues(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SELECT_VALUES && value.every(validText);
}

function randomKey(prefix: string): string {
  return `__shadowedge_rpa_${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function sameFrames(left: string[] | undefined, right: string[] | undefined): boolean {
  return left === right || (left?.length === right?.length &&
    (left === undefined || left.every((value, index) => value === right?.[index])));
}

export class RpaRecorder {
  private readonly sessions = new Map<Uuid, RecordingSession>();

  constructor(private readonly kernel: BrowserKernel) {}

  isRecording(profileId: Uuid): boolean {
    return this.sessions.has(profileId);
  }

  async start(profileId: Uuid, startUrl: string): Promise<RpaRecordingState> {
    if (this.sessions.has(profileId)) {
      throw new ShadowEdgeError('E_RPA_RECORDING_ACTIVE', `环境 ${profileId} 已在录制`);
    }
    const context = this.kernel.getAutomationContext(profileId);
    const page = context.pages()[0] ?? await context.newPage();
    const state: RpaRecordingState = {
      profileId,
      startUrl: parseStartUrl(startUrl),
      startedAt: new Date().toISOString(),
    };
    const session: RecordingSession = {
      context,
      bindingName: randomKey('record'),
      cleanupKey: randomKey('cleanup'),
      frameTokenKey: randomKey('frame'),
      currentPage: page,
      pages: new Map(),
      pageOrder: context.pages(),
      actions: [{ kind: 'navigate', url: state.startUrl }],
      ignoredPasswordSelectors: new Set(),
      droppedActions: 0,
      active: false,
      queue: Promise.resolve(),
      onContextPage: () => undefined,
    };
    session.onContextPage = (created) => {
      if (!session.active || session.pages.has(created)) return;
      session.queue = session.queue.then(() => this.adoptPage(session, created));
    };
    // 先占用环境再执行异步浏览器调用，rpa:run 会在同一事件循环中看到录制状态。
    this.sessions.set(profileId, session);
    context.on('page', session.onContextPage);
    try {
      // Context 级绑定先于所有录制脚本安装，新页面及其首个文档无需等待 page 级绑定。
      session.binding = await context.exposeBinding(session.bindingName,
        (source: { page: Page }, payload: unknown) => this.receiveFromContext(session, source.page, payload));
      session.initScript = await context.addInitScript(recordingScript, {
        bindingName: session.bindingName,
        cleanupKey: session.cleanupKey,
        frameTokenKey: session.frameTokenKey,
      });
      // 录制前已经存在的标签页也纳入索引，否则关闭或切回这些页面无法准确回放。
      for (const existing of session.pageOrder) await this.attachPage(session, existing, true);
      await page.goto(state.startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      session.active = true;
      return state;
    } catch (error) {
      await this.cleanup(session);
      this.sessions.delete(profileId);
      throw error;
    }
  }

  async stop(profileId: Uuid): Promise<RpaRecordingResult> {
    const session = this.sessions.get(profileId);
    if (!session) {
      throw new ShadowEdgeError('E_RPA_RECORDING_NOT_FOUND', `环境 ${profileId} 没有进行中的录制`);
    }
    session.active = false;
    this.sessions.delete(profileId);
    try {
      await session.queue;
      return {
        graph: buildRecordedGraph(session.actions),
        ignoredPasswordFields: session.ignoredPasswordSelectors.size,
        droppedActions: session.droppedActions,
      };
    } finally {
      await this.cleanup(session);
    }
  }

  private append(session: RecordingSession, action: RpaRecordedAction): void {
    if (session.actions.length >= MAX_ACTIONS) {
      session.droppedActions += 1;
      return;
    }
    const previous = session.actions.at(-1);
    if (action.kind === 'type' && previous?.kind === 'type' &&
      previous.selector === action.selector && previous.frameSelector === action.frameSelector &&
      sameFrames(previous.frameSelectors, action.frameSelectors) &&
      sameFrames(previous.selectors, action.selectors)) {
      previous.text = action.text;
      return;
    }
    if (action.kind === 'select' && previous?.kind === 'select' &&
      previous.selector === action.selector && previous.frameSelector === action.frameSelector &&
      sameFrames(previous.frameSelectors, action.frameSelectors) &&
      sameFrames(previous.selectors, action.selectors)) {
      if ('values' in action && 'values' in previous) {
        previous.values = [...action.values];
        return;
      }
      if ('value' in action && 'value' in previous) {
        previous.value = action.value;
        return;
      }
    }
    session.actions.push(action);
  }

  private ensureCurrentPage(session: RecordingSession, page: Page): void {
    if (session.currentPage === page) return;
    const index = session.pageOrder.indexOf(page);
    if (index < 0) return;
    this.append(session, { kind: 'switchTab', index });
    session.currentPage = page;
  }

  private async attachPage(
    session: RecordingSession,
    page: Page,
    installCurrentDocument = false,
  ): Promise<void> {
    const record: RecordingPage = {
      page,
      onFrameNavigated: () => undefined,
      onClose: () => undefined,
    };
    record.onFrameNavigated = (frame) => {
      if (!session.active || frame !== page.mainFrame() || session.currentPage !== page) return;
      const url = frame.url();
      if (!/^https?:\/\//.test(url)) return;
      const previous = session.actions.at(-1);
      if (previous?.kind === 'navigate' && previous.url === url) return;
      this.append(session, { kind: 'navigate', url });
    };
    record.onClose = () => {
      if (!session.active) return;
      session.queue = session.queue.then(() => this.closePage(session, record));
    };
    session.pages.set(page, record);
    page.on('close', record.onClose);
    page.on('framenavigated', record.onFrameNavigated);
    try {
      // Context init script 已覆盖新页面的首个文档；只有录制前存在的页面需要补装。
      if (installCurrentDocument) {
        await page.evaluate(recordingScript, {
          bindingName: session.bindingName,
          cleanupKey: session.cleanupKey,
          frameTokenKey: session.frameTokenKey,
        });
      }
    } catch (error) {
      page.off('close', record.onClose);
      page.off('framenavigated', record.onFrameNavigated);
      session.pages.delete(page);
      throw error;
    }
  }

  private async adoptPage(session: RecordingSession, page: Page): Promise<void> {
    if (!session.active || page.isClosed() || session.pages.has(page)) return;
    session.pageOrder.push(page);
    const index = session.pageOrder.length - 1;
    const opener = await page.opener().catch(() => null);
    this.append(session, opener ? { kind: 'switchTab', index } : { kind: 'newTab' });
    session.currentPage = page;
    await this.attachPage(session, page);
    const url = page.url();
    const previous = session.actions.at(-1);
    if (/^https?:\/\//.test(url) && !(previous?.kind === 'navigate' && previous.url === url)) {
      this.append(session, { kind: 'navigate', url });
    }
  }

  private closePage(session: RecordingSession, record: RecordingPage): void {
    if (!session.pages.has(record.page)) return;
    const index = session.pageOrder.indexOf(record.page);
    if (index < 0) return;
    this.append(session, { kind: 'closeTab', index });
    session.pages.delete(record.page);
    session.pageOrder.splice(index, 1);
    if (session.currentPage === record.page && session.pageOrder.length > 0) {
      // 与 closeTab 执行器一致：优先同索引，否则使用最后一个剩余页面。
      session.currentPage = session.pageOrder[Math.min(index, session.pageOrder.length - 1)]!;
    }
  }

  private async framePath(
    session: RecordingSession,
    record: RecordingPage,
    token: unknown,
  ): Promise<string[] | undefined> {
    if (typeof token !== 'string' || token.length !== 32) return undefined;
    for (const frame of record.page.frames()) {
      const actual = await frame.evaluate((key) =>
        document.documentElement?.getAttribute(key), session.frameTokenKey).catch(() => undefined);
      if (actual !== token) continue;
      const selectors: string[] = [];
      let current: Frame | null = frame;
      while (current && current !== record.page.mainFrame()) {
        const element = await current.frameElement().catch(() => null);
        if (!element) return undefined;
        try {
          const selector = await element.evaluate(stableElementSelector);
          if (!validSelector(selector)) return undefined;
          selectors.unshift(selector);
        } finally {
          await element.dispose();
        }
        current = current.parentFrame();
      }
      return selectors;
    }
    return undefined;
  }

  private receiveFromContext(session: RecordingSession, page: Page, payload: unknown): void {
    // close 事件可能先于 binding 回调到达；已纳管页面的关闭前事件仍需进入同一队列。
    if (!session.active || !isRecord(payload)) return;
    session.queue = session.queue.then(async () => {
      if (!session.pages.has(page)) await this.adoptPage(session, page);
      const record = session.pages.get(page);
      if (record) await this.receive(session, record, payload);
    });
  }

  private async receive(session: RecordingSession, record: RecordingPage, payload: unknown): Promise<void> {
    if (!isRecord(payload)) return;
    if (payload.kind === 'activate') {
      this.ensureCurrentPage(session, record.page);
      return;
    }
    if (!validSelector(payload.selector)) return;
    const frames = payload.topFrame === true ? [] : await this.framePath(session, record, payload.frameToken);
    if (!frames) {
      session.droppedActions += 1;
      return;
    }
    if (payload.selectors !== undefined && !validSelectors(payload.selectors)) return;
    const frameKey = frames.join('\0');
    const target = {
      selector: payload.selector,
      frameSelectors: frames.length > 0 ? frames : undefined,
      selectors: Array.isArray(payload.selectors) && payload.selectors.length > 0
        ? [...payload.selectors] : undefined,
    };
    if (payload.kind === 'password') {
      session.ignoredPasswordSelectors.add(`${frameKey}\0${payload.selector}`);
      return;
    }
    if (payload.kind === 'unsupported') {
      session.droppedActions += 1;
      return;
    }
    this.ensureCurrentPage(session, record.page);
    if (payload.kind === 'click') {
      this.append(session, { kind: 'click', ...target });
    } else if (payload.kind === 'type' && validText(payload.value)) {
      this.append(session, { kind: 'type', ...target, text: payload.value });
    } else if (payload.kind === 'select' && validText(payload.value)) {
      this.append(session, { kind: 'select', ...target, value: payload.value });
    } else if (payload.kind === 'select' && validSelectValues(payload.values)) {
      this.append(session, { kind: 'select', ...target, values: [...payload.values] });
    } else if (payload.kind === 'check' && typeof payload.checked === 'boolean') {
      this.append(session, { kind: 'check', ...target, checked: payload.checked });
    }
  }

  private async cleanup(session: RecordingSession): Promise<void> {
    session.context.off('page', session.onContextPage);
    for (const record of session.pages.values()) {
      record.page.off('close', record.onClose);
      record.page.off('framenavigated', record.onFrameNavigated);
      if (!record.page.isClosed()) {
        await record.page.evaluate((key) => {
          const cleanup: unknown = Reflect.get(window, key);
          if (typeof cleanup === 'function') cleanup();
        }, session.cleanupKey).catch(() => undefined);
      }
    }
    session.pages.clear();
    session.pageOrder = [];
    await session.initScript?.dispose().catch(() => undefined);
    await session.binding?.dispose().catch(() => undefined);
  }
}
