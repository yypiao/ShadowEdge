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
import type { Disposable, Page } from 'patchright';

const MAX_ACTIONS = 500;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_TEXT_LENGTH = 10000;

interface RecordingSession {
  page: Page;
  state: RpaRecordingState;
  actions: RpaRecordedAction[];
  ignoredPasswordSelectors: Set<string>;
  droppedActions: number;
  active: boolean;
  cleanupKey: string;
  initScript?: Disposable;
  onFrameNavigated: (frame: ReturnType<Page['mainFrame']>) => void;
  onPageClose: () => void;
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

/**
 * 在页面主世界监听可信操作。绑定回调只接收选择器和普通输入值；密码分支不读取 value。
 * 停止后由主进程调用清理函数，之后即使 init script 在新文档执行也不会记录任何数据。
 */
function recordingScript(options: { bindingName: string; cleanupKey: string }): void {
  const emit = (payload: Record<string, unknown>): void => {
    // exposeFunction 与业务 init script 的执行顺序不应影响录制，事件发生时再解析绑定。
    const binding: unknown = Reflect.get(window, options.bindingName);
    if (typeof binding === 'function') void binding(payload);
  };
  const unique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const stableSelector = (element: Element): string | undefined => {
    const id = element.getAttribute('id');
    if (id) {
      const selector = `#${CSS.escape(id)}`;
      if (unique(selector)) return selector;
    }
    for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = `${element.tagName.toLowerCase()}[${attribute}=${CSS.escape(value)}]`;
      if (unique(selector)) return selector;
    }
    const path: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) {
        path.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current!.tagName);
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
      path.unshift(`${tag}${suffix}`);
      current = parent;
    }
    const selector = path.join(' > ');
    return selector && unique(selector) ? selector : undefined;
  };
  const onClick = (event: MouseEvent): void => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement &&
      !['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(target.type)) return;
    const selector = stableSelector(target);
    if (selector) emit({ kind: 'click', selector });
  };
  const onChange = (event: Event): void => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    const selector = stableSelector(target);
    if (!selector) return;
    if ((target instanceof HTMLInputElement && target.type === 'password') ||
      ['current-password', 'new-password'].includes(target.getAttribute('autocomplete') ?? '')) {
      emit({ kind: 'password', selector });
      return;
    }
    if (target instanceof HTMLInputElement &&
      ['hidden', 'checkbox', 'radio', 'file', 'button', 'submit', 'reset'].includes(target.type)) return;
    emit({ kind: 'type', selector, value: target.value });
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  Reflect.set(window, options.cleanupKey, () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
  });
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
    const bindingName = `__shadowedge_rpa_record_${randomUUID().replaceAll('-', '')}`;
    const cleanupKey = `__shadowedge_rpa_cleanup_${randomUUID().replaceAll('-', '')}`;
    const session: RecordingSession = {
      page,
      state,
      actions: [{ kind: 'navigate', url: state.startUrl }],
      ignoredPasswordSelectors: new Set(),
      droppedActions: 0,
      active: false,
      cleanupKey,
      onFrameNavigated: () => undefined,
      onPageClose: () => undefined,
    };
    const append = (action: RpaRecordedAction): void => {
      if (!session.active) return;
      if (session.actions.length >= MAX_ACTIONS) {
        session.droppedActions += 1;
        return;
      }
      const previous = session.actions.at(-1);
      if (action.kind === 'type' && previous?.kind === 'type' && previous.selector === action.selector) {
        previous.text = action.text;
        return;
      }
      session.actions.push(action);
    };
    const receive = (payload: unknown): void => {
      if (!session.active || !isRecord(payload) || !validSelector(payload.selector)) return;
      if (payload.kind === 'password') {
        session.ignoredPasswordSelectors.add(payload.selector);
      } else if (payload.kind === 'click') {
        append({ kind: 'click', selector: payload.selector });
      } else if (payload.kind === 'type' && typeof payload.value === 'string' &&
        payload.value.length <= MAX_TEXT_LENGTH) {
        append({ kind: 'type', selector: payload.selector, text: payload.value });
      }
    };
    session.onFrameNavigated = (frame) => {
      if (!session.active || frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!/^https?:\/\//.test(url)) return;
      const previous = session.actions.at(-1);
      if (previous?.kind === 'navigate' && previous.url === url) return;
      append({ kind: 'navigate', url });
    };
    session.onPageClose = () => {
      session.active = false;
      if (this.sessions.get(profileId) === session) this.sessions.delete(profileId);
    };
    // 先占用环境再执行异步浏览器调用，rpa:run 会在同一事件循环中看到录制状态。
    this.sessions.set(profileId, session);
    page.on('close', session.onPageClose);
    page.on('framenavigated', session.onFrameNavigated);
    try {
      await page.exposeFunction(bindingName, receive);
      session.initScript = await page.addInitScript(recordingScript, { bindingName, cleanupKey });
      await page.goto(state.startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      session.active = true;
      return state;
    } catch (error) {
      session.active = false;
      this.sessions.delete(profileId);
      page.off('close', session.onPageClose);
      page.off('framenavigated', session.onFrameNavigated);
      await session.initScript?.dispose().catch(() => undefined);
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
    session.page.off('close', session.onPageClose);
    session.page.off('framenavigated', session.onFrameNavigated);
    await session.initScript?.dispose().catch(() => undefined);
    if (!session.page.isClosed()) {
      await session.page.evaluate((key) => {
        const cleanup: unknown = Reflect.get(window, key);
        if (typeof cleanup === 'function') cleanup();
      }, session.cleanupKey).catch(() => undefined);
    }
    return {
      graph: buildRecordedGraph(session.actions),
      ignoredPasswordFields: session.ignoredPasswordSelectors.size,
      droppedActions: session.droppedActions,
    };
  }
}
