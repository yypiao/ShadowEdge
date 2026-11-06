export interface RecordingScriptOptions {
  bindingName: string;
  cleanupKey: string;
  frameTokenKey: string;
}

/** 在调用方所属 Document/ShadowRoot 内计算唯一定位，不依赖页面 window 上的跨世界状态。 */
export function stableElementSelector(element: Element): string | undefined {
  const unique = (root: Document | ShadowRoot, selector: string): boolean => {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const localSelector = (target: Element, root: Document | ShadowRoot): string | undefined => {
    const id = target.getAttribute('id');
    if (id) {
      const selector = `#${CSS.escape(id)}`;
      if (unique(root, selector)) return selector;
    }
    for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const value = target.getAttribute(attribute);
      if (!value) continue;
      const selector = `${target.tagName.toLowerCase()}[${attribute}=${CSS.escape(value)}]`;
      if (unique(root, selector)) return selector;
    }
    const path: string[] = [];
    let current: Element | null = target;
    while (current) {
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
    return selector && unique(root, selector) ? selector : undefined;
  };
  const root = element.getRootNode();
  if (!(root instanceof Document) && !(root instanceof ShadowRoot)) return undefined;
  const selector = localSelector(element, root);
  if (!selector || root instanceof Document) return selector;
  const host = stableElementSelector(root.host);
  return host ? `${host} >> css=${selector}` : undefined;
}

/**
 * 页面内只采集可重放的操作；密码和本地文件路径不会通过绑定发送到主进程。
 * ShadowRoot 的 change 不冒泡到 document，必须直接在对应 root 监听。
 */
export function recordingScript(options: RecordingScriptOptions): void {
  const previousCleanup: unknown = Reflect.get(window, options.cleanupKey);
  if (typeof previousCleanup === 'function') previousCleanup();

  const frameToken = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (value) => value.toString(16).padStart(2, '0')).join('');
  const publishFrameToken = (): void => {
    const binding: unknown = Reflect.get(window, options.bindingName);
    if (typeof binding !== 'function') return;
    // Patchright 的后续 evaluate 可能处于不同世界；DOM 属性在各世界间一致且停止时可完整移除。
    document.documentElement?.setAttribute(options.frameTokenKey, frameToken);
  };
  document.addEventListener('DOMContentLoaded', publishFrameToken, { once: true });
  const emit = (payload: Record<string, unknown>): void => {
    publishFrameToken();
    // exposeFunction 与业务 init script 的执行顺序不应影响录制，事件发生时再解析绑定。
    const binding: unknown = Reflect.get(window, options.bindingName);
    if (typeof binding === 'function') {
      void binding({
        ...payload,
        frameToken,
        topFrame: window === window.top,
      });
    }
  };
  // addInitScript 只序列化本函数，不携带模块闭包；事件处理器必须使用这份内部实现。
  const stableSelector = (element: Element): string | undefined => {
    const unique = (root: Document | ShadowRoot, selector: string): boolean => {
      try {
        return root.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    const localSelector = (target: Element, root: Document | ShadowRoot): string | undefined => {
      const id = target.getAttribute('id');
      if (id) {
        const selector = `#${CSS.escape(id)}`;
        if (unique(root, selector)) return selector;
      }
      for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
        const value = target.getAttribute(attribute);
        if (!value) continue;
        const selector = `${target.tagName.toLowerCase()}[${attribute}=${CSS.escape(value)}]`;
        if (unique(root, selector)) return selector;
      }
      const path: string[] = [];
      let current: Element | null = target;
      while (current) {
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
      return selector && unique(root, selector) ? selector : undefined;
    };
    const root = element.getRootNode();
    if (!(root instanceof Document) && !(root instanceof ShadowRoot)) return undefined;
    const selector = localSelector(element, root);
    if (!selector || root instanceof Document) return selector;
    const host = stableSelector(root.host);
    return host ? `${host} >> css=${selector}` : undefined;
  };
  const isPassword = (target: Element): boolean =>
    (target instanceof HTMLInputElement && target.type === 'password') ||
    ['current-password', 'new-password'].includes(target.getAttribute('autocomplete') ?? '');
  const handled = new WeakSet<Event>();
  const isRetargetedShadowEvent = (event: Event): boolean => {
    const target = event.target;
    return target instanceof Element && target.shadowRoot !== null && event.composedPath()[0] !== target;
  };
  const onClick = (event: Event): void => {
    if (isRetargetedShadowEvent(event)) return;
    if (handled.has(event)) return;
    handled.add(event);
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
      target.closest('select') || (target instanceof HTMLElement && target.isContentEditable)) return;
    if (target instanceof HTMLInputElement &&
      !['button', 'submit', 'reset'].includes(target.type)) return;
    const selector = stableSelector(target);
    if (selector) emit({ kind: 'click', selector });
  };
  const onChange = (event: Event): void => {
    if (isRetargetedShadowEvent(event)) return;
    if (handled.has(event)) return;
    handled.add(event);
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) &&
      !(target instanceof HTMLSelectElement)) return;
    const selector = stableSelector(target);
    if (!selector) return;
    if (isPassword(target)) {
      emit({ kind: 'password', selector });
      return;
    }
    if (target instanceof HTMLSelectElement) {
      if (target.multiple) {
        emit({
          kind: 'select',
          selector,
          values: Array.from(target.selectedOptions).map((option) => option.value),
        });
      } else {
        emit({ kind: 'select', selector, value: target.value });
      }
      return;
    }
    if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
      emit({ kind: 'check', selector, checked: target.checked });
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'file') {
      emit({ kind: 'unsupported', selector });
      return;
    }
    // 文本已在 input 时增量记录；这里只保留下拉、勾选和文件等 change 语义。
  };
  const onInput = (event: Event): void => {
    if (isRetargetedShadowEvent(event)) return;
    if (handled.has(event)) return;
    handled.add(event);
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.isContentEditable) {
      const selector = stableSelector(target);
      if (!selector) return;
      if (isPassword(target)) emit({ kind: 'password', selector });
      else emit({ kind: 'type', selector, value: target.textContent ?? '' });
      return;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const selector = stableSelector(target);
      if (!selector) return;
      if (isPassword(target)) {
        emit({ kind: 'password', selector });
        return;
      }
      if (target instanceof HTMLInputElement &&
        ['hidden', 'checkbox', 'radio', 'file', 'button', 'submit', 'reset'].includes(target.type)) return;
      emit({ kind: 'type', selector, value: target.value });
    }
  };
  const roots = new Set<Document | ShadowRoot>();
  const installRoot = (root: Document | ShadowRoot): void => {
    if (roots.has(root)) return;
    roots.add(root);
    root.addEventListener('click', onClick, true);
    root.addEventListener('change', onChange, true);
    root.addEventListener('input', onInput, true);
  };
  const scanShadowRoots = (): void => {
    installRoot(document);
    for (const element of Array.from(document.querySelectorAll('*'))) {
      if (element.shadowRoot) installRoot(element.shadowRoot);
    }
  };
  // 不改写 attachShadow 原生函数，避免录制功能自身引入可检测的原型痕迹。
  scanShadowRoots();
  const shadowScanInterval = setInterval(() => {
    // Patchright 不保证 binding 与业务 init script 的顺序，就绪标记需等待二者均可用。
    publishFrameToken();
    scanShadowRoots();
  }, 100);

  const observer = new MutationObserver(scanShadowRoots);
  observer.observe(document, { childList: true, subtree: true });
  const onActivate = (): void => emit({ kind: 'activate' });
  window.addEventListener('focus', onActivate);
  // 对测试和人工操作均表示全部监听器已安装，而不是仅开始执行注入函数。
  publishFrameToken();
  Reflect.set(window, options.cleanupKey, () => {
    observer.disconnect();
    clearInterval(shadowScanInterval);
    for (const root of roots) {
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('change', onChange, true);
      root.removeEventListener('input', onInput, true);
    }
    roots.clear();
    document.removeEventListener('DOMContentLoaded', publishFrameToken);
    window.removeEventListener('focus', onActivate);
    document.documentElement?.removeAttribute(options.frameTokenKey);
    Reflect.deleteProperty(window, options.cleanupKey);
  });
}
