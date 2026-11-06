import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IpcEvents, RpaGraph, RpaRun, RpaWorkflow } from '@shadowedge/core';
import { RpaEngine } from '../src/index.js';
import type { RpaFrameLocator, RpaLocator, RpaMouse, RpaPage } from '../src/index.js';

class FakeLocator implements RpaLocator {
  value = '';
  selected: string | string[] = '';
  checked = false;
  files = '';
  constructor(private readonly text: string | null = 'extracted') {}

  async waitFor(_options: { state: 'visible'; timeout: number }): Promise<void> {}
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    return { x: 100, y: 100, width: 40, height: 20 };
  }
  async fill(value: string): Promise<void> {
    this.value = value;
  }
  async pressSequentially(value: string, _options: { delay: number }): Promise<void> {
    this.value += value;
  }
  async textContent(): Promise<string | null> {
    return this.text;
  }
  async getAttribute(_name: string): Promise<string | null> {
    return this.text;
  }
  async selectOption(value: string | string[]): Promise<string[]> {
    this.selected = value;
    return Array.isArray(value) ? value : [value];
  }
  async setChecked(checked: boolean): Promise<void> {
    this.checked = checked;
  }
  async setInputFiles(files: string): Promise<void> {
    this.files = files;
  }
}

class FakeFrameLocator implements RpaFrameLocator {
  constructor(private readonly page: FakePage) {}
  locator(selector: string): RpaLocator {
    return this.page.locator(selector);
  }
  frameLocator(_selector: string): RpaFrameLocator {
    return this;
  }
}

class FakeMouse implements RpaMouse {
  moves: Array<{ x: number; y: number }> = [];
  clicks: Array<{ x: number; y: number }> = [];
  async move(x: number, y: number): Promise<void> {
    this.moves.push({ x, y });
  }
  async click(x: number, y: number): Promise<void> {
    this.clicks.push({ x, y });
  }
}

class FakePage implements RpaPage {
  readonly mouse = new FakeMouse();
  readonly input = new FakeLocator();
  readonly urls: string[] = [];
  gotoFailures = 0;
  blockGoto = false;
  closed = false;
  private rejectBlockedGoto?: (error: Error) => void;

  async goto(url: string): Promise<null> {
    if (this.blockGoto) {
      return new Promise<null>((_resolve, reject) => { this.rejectBlockedGoto = reject; });
    }
    if (this.gotoFailures > 0) {
      this.gotoFailures -= 1;
      throw new Error('temporary navigation failure');
    }
    this.urls.push(url);
    return null;
  }
  locator(selector: string): RpaLocator {
    return selector === '#input' ? this.input : new FakeLocator();
  }
  frameLocator(_selector: string): RpaFrameLocator {
    return new FakeFrameLocator(this);
  }
  async bringToFront(): Promise<void> {}
  async waitForEvent(): Promise<never> {
    throw new Error('fake download not configured');
  }
  async close(): Promise<void> {
    this.closed = true;
    this.rejectBlockedGoto?.(new Error('page closed'));
  }
  async screenshot(options: { path: string; fullPage: boolean; type: 'png' }): Promise<Uint8Array> {
    writeFileSync(options.path, 'fake-png');
    return new Uint8Array([1]);
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workflow(graph: RpaGraph): RpaWorkflow {
  return {
    id: 'workflow-test',
    orgId: 'local',
    name: 'test',
    version: 1,
    graph,
    createdBy: 'local-user',
    updatedAt: new Date().toISOString(),
  };
}

function setup(page: FakePage) {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-test-'));
  tempDirs.push(artifactsDir);
  const progress: IpcEvents['rpa:progress'][] = [];
  const engine = new RpaEngine({
    resolveContext: () => ({ pages: () => [page], newPage: async () => page }),
    artifactsDir,
    random: () => 0,
    emit: (event) => progress.push(event),
  });
  return { engine, progress };
}

async function finish(engine: RpaEngine, runs: RpaRun[]): Promise<RpaRun> {
  return engine.wait(runs[0]!.id);
}

describe('RpaEngine 真实节点执行语义', () => {
  it('执行 navigate/type/click/wait/extract/screenshot 并生成产物', async () => {
    const page = new FakePage();
    const { engine, progress } = setup(page);
    const graph: RpaGraph = {
      entry: 'open',
      nodes: {
        open: {
          id: 'open',
          kind: 'navigate',
          params: { url: 'https://example.com' },
          next: 'type',
        },
        type: {
          id: 'type',
          kind: 'type',
          params: { selector: '#input', text: '{{inputs.text}}' },
          next: 'click',
        },
        click: { id: 'click', kind: 'click', params: { selector: '#submit' }, next: 'wait' },
        wait: { id: 'wait', kind: 'wait', params: { ms: 0 }, next: 'extract' },
        extract: {
          id: 'extract',
          kind: 'extract',
          params: { selector: '#result', key: 'result' },
          next: 'shot',
        },
        shot: { id: 'shot', kind: 'screenshot', params: { key: 'final' } },
      },
    };
    const result = await finish(
      engine,
      await engine.run(workflow(graph), ['profile-a'], { text: 'Hi' }),
    );

    expect(result.status).toBe('succeeded');
    expect(page.urls).toEqual(['https://example.com']);
    expect(page.input.value).toBe('Hi');
    expect(page.mouse.moves).toHaveLength(16);
    expect(page.mouse.clicks).toEqual([{ x: 120, y: 110 }]);
    expect(result.outputs).toEqual({ result: 'extracted' });
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(['screenshot', 'json']);
    for (const artifact of result.artifacts) expect(existsSync(artifact.uri)).toBe(true);
    const jsonArtifact = result.artifacts.find((artifact) => artifact.kind === 'json')!;
    expect(JSON.parse(readFileSync(jsonArtifact.uri, 'utf8'))).toEqual({ result: 'extracted' });
    expect(progress.at(-1)).toEqual({ runId: result.id, step: 'succeeded', percent: 100 });
  });

  it('下拉框、复选框和上传节点调用真实控件语义', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'select',
      nodes: {
        select: { id: 'select', kind: 'select', params: { selector: '#input', value: 'GB' }, next: 'check' },
        check: { id: 'check', kind: 'check', params: { selector: '#input', checked: true }, next: 'upload' },
        upload: { id: 'upload', kind: 'upload', params: { selector: '#input', path: '/tmp/upload.txt' } },
      },
    }), ['profile-a']));
    expect(result.status).toBe('succeeded');
    expect(page.input.selected).toBe('GB');
    expect(page.input.checked).toBe(true);
    expect(page.input.files).toBe('/tmp/upload.txt');
  });

  it('retry 按次数重试并成功', async () => {
    const page = new FakePage();
    page.gotoFailures = 2;
    const { engine, progress } = setup(page);
    const runs = await engine.run(
      workflow({
        entry: 'open',
        nodes: {
          open: {
            id: 'open',
            kind: 'navigate',
            params: { url: 'https://example.com' },
            onError: 'retry',
            retries: 2,
          },
        },
      }),
      ['profile-a'],
    );
    const result = await finish(engine, runs);
    expect(result.status).toBe('succeeded');
    expect(page.urls).toEqual(['https://example.com']);
    expect(progress.filter((event) => event.step.includes(':retry:'))).toHaveLength(2);
  });

  it('onError=continue 跳过失败节点并保留后续输出', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(
      engine,
      await engine.run(
        workflow({
          entry: 'bad',
          nodes: {
            bad: {
              id: 'bad',
              kind: 'navigate',
              params: { url: 'not-a-url' },
              onError: 'continue',
              next: 'extract',
            },
            extract: {
              id: 'extract',
              kind: 'extract',
              params: { selector: '#result', key: 'value' },
            },
          },
        }),
        ['profile-a'],
      ),
    );
    expect(result.status).toBe('succeeded');
    expect(result.outputs).toEqual({ value: 'extracted' });
  });

  it('默认 stop 将运行标记为 failed 且不执行后续节点', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(
      engine,
      await engine.run(
        workflow({
          entry: 'bad',
          nodes: {
            bad: { id: 'bad', kind: 'navigate', params: { url: 'not-a-url' }, next: 'extract' },
            extract: {
              id: 'extract',
              kind: 'extract',
              params: { selector: '#result', key: 'value' },
            },
          },
        }),
        ['profile-a'],
      ),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('节点 bad');
    expect(result.outputs).toEqual({});
  });

  it('条件选择真分支，提取结果与 inputs 可在后续输入复用', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'extract',
      nodes: {
        extract: { id: 'extract', kind: 'extract', params: { selector: '#result', key: 'result' }, next: 'condition' },
        condition: {
          id: 'condition', kind: 'condition',
          params: { left: '{{outputs.result}}', operator: 'equals', right: 'extracted' },
          next: 'type', elseNext: 'bad',
        },
        type: {
          id: 'type', kind: 'type',
          params: { selector: '#input', text: '{{outputs.result}}-{{inputs.suffix}}' },
        },
        bad: { id: 'bad', kind: 'navigate', params: { url: 'https://wrong.example' } },
      },
    }), ['profile-a'], { suffix: 'done' }));
    expect(result.status).toBe('succeeded');
    expect(page.input.value).toBe('extracted-done');
    expect(page.urls).toEqual([]);
  });

  it('计数循环精确执行三次并暴露从零开始的循环索引', async () => {
    const page = new FakePage();
    const { engine, progress } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'repeat',
      nodes: {
        repeat: { id: 'repeat', kind: 'loop', params: { count: 3, body: 'type' }, next: 'extract' },
        type: {
          id: 'type', kind: 'type',
          params: { selector: '#input', text: 'item-{{loop.repeat.index}}' },
          next: 'repeat',
        },
        extract: { id: 'extract', kind: 'extract', params: { selector: '#result', key: 'done' } },
      },
    }), ['profile-a']));
    expect(result.status).toBe('succeeded');
    expect(page.input.value).toBe('item-2');
    expect(progress.filter((event) => event.step === 'type')).toHaveLength(3);
  });

  it('循环次数可来自 inputs，零次循环跳过循环体', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'repeat',
      nodes: {
        repeat: { id: 'repeat', kind: 'loop', params: { count: '{{inputs.count}}', body: 'type' }, next: 'extract' },
        type: { id: 'type', kind: 'type', params: { selector: '#input', text: 'never' }, next: 'repeat' },
        extract: { id: 'extract', kind: 'extract', params: { selector: '#result', key: 'done' } },
      },
    }), ['profile-a'], { count: 0 }));
    expect(result.status).toBe('succeeded');
    expect(page.input.value).toBe('');
    expect(result.outputs).toEqual({ done: 'extracted' });
  });

  it('最大步数能终止错误的高次数循环', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'repeat', maxSteps: 2,
      nodes: {
        repeat: { id: 'repeat', kind: 'loop', params: { count: 3, body: 'type' } },
        type: { id: 'type', kind: 'type', params: { selector: '#input', text: 'x' }, next: 'repeat' },
      },
    }), ['profile-a']));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('最大步数 2');
  });

  it('整体超时标记 failed 而不是用户取消', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'wait', timeoutMs: 20,
      nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 10000 } } },
    }), ['profile-a']));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('总超时 20ms');
  });

  it('挂起导航在总超时时关闭页面、停止后续节点并释放环境锁', async () => {
    const page = new FakePage();
    page.blockGoto = true;
    const { engine } = setup(page);
    const definition = workflow({
      entry: 'open', timeoutMs: 20,
      nodes: {
        open: { id: 'open', kind: 'navigate', params: { url: 'https://example.com', timeout: 60000 }, next: 'type' },
        type: { id: 'type', kind: 'type', params: { selector: '#input', text: 'must-not-run' } },
      },
    });
    const first = (await engine.run(definition, ['profile-a']))[0]!;
    const result = await engine.wait(first.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('总超时 20ms');
    expect(page.closed).toBe(true);
    expect(page.input.value).toBe('');

    const next = (await engine.run(workflow({
      entry: 'wait', nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } },
    }), ['profile-a']))[0]!;
    expect((await engine.wait(next.id)).status).toBe('succeeded');
  });

  it('手动取消挂起导航会等待页面关闭并释放环境锁', async () => {
    const page = new FakePage();
    page.blockGoto = true;
    const { engine } = setup(page);
    const first = (await engine.run(workflow({
      entry: 'open',
      nodes: {
        open: { id: 'open', kind: 'navigate', params: { url: 'https://example.com', timeout: 60000 }, next: 'shot' },
        shot: { id: 'shot', kind: 'screenshot', params: { key: 'must-not-exist' } },
      },
    }), ['profile-a']))[0]!;
    await engine.cancel(first.id);
    const result = await engine.wait(first.id);
    expect(result.status).toBe('cancelled');
    expect(result.artifacts).toEqual([]);
    expect(page.closed).toBe(true);

    const next = (await engine.run(workflow({
      entry: 'wait', nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } },
    }), ['profile-a']))[0]!;
    expect((await engine.wait(next.id)).status).toBe('succeeded');
  });

  it('缺失输出可进入 notExists 分支，不会误报节点执行失败', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const result = await finish(engine, await engine.run(workflow({
      entry: 'condition',
      nodes: {
        condition: {
          id: 'condition', kind: 'condition',
          params: { left: '{{outputs.notCreated}}', operator: 'notExists' },
          next: 'empty', elseNext: 'wrong',
        },
        empty: { id: 'empty', kind: 'extract', params: { selector: '#result', key: 'branch' } },
        wrong: { id: 'wrong', kind: 'type', params: { selector: '#input', text: 'wrong' } },
      },
    }), ['profile-a']));
    expect(result.status).toBe('succeeded');
    expect(result.outputs).toEqual({ branch: 'extracted' });
    expect(page.input.value).toBe('');
  });

  it('cancel 能中断等待并标记 cancelled', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const runs = await engine.run(
      workflow({
        entry: 'wait',
        nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 10000 } } },
      }),
      ['profile-a'],
    );
    await engine.cancel(runs[0]!.id);
    const result = await engine.wait(runs[0]!.id);
    expect(result.status).toBe('cancelled');
    expect(result.finishedAt).toBeDefined();
  });

  it('同一环境拒绝并行工作流，取消后释放执行锁', async () => {
    const page = new FakePage();
    const { engine } = setup(page);
    const definition = workflow({
      entry: 'wait',
      nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 10000 } } },
    });
    const first = (await engine.run(definition, ['profile-a']))[0]!;
    const second = (await engine.run(definition, ['profile-a']))[0]!;
    expect(second.status).toBe('failed');
    expect(second.error).toContain('已有正在执行');
    await engine.cancel(first.id);
    expect((await engine.wait(first.id)).status).toBe('cancelled');

    const thirdDefinition = workflow({
      entry: 'wait',
      nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } },
    });
    const third = (await engine.run(thirdDefinition, ['profile-a']))[0]!;
    expect((await engine.wait(third.id)).status).toBe('succeeded');
  });

  it('产物目录不可写时进入 failed，不会留下永远 running 的记录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-test-'));
    tempDirs.push(dir);
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'blocked');
    const engine = new RpaEngine({
      resolveContext: () => ({
        pages: () => [new FakePage()],
        newPage: async () => new FakePage(),
      }),
      artifactsDir: blocked,
    });
    const result = await finish(
      engine,
      await engine.run(
        workflow({
          entry: 'wait',
          nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } },
        }),
        ['profile-a'],
      ),
    );
    expect(result.status).toBe('failed');
    expect(result.finishedAt).toBeDefined();
    expect(result.error).toBeTruthy();
  });

  it('环境未运行只让对应批量项失败', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-test-'));
    tempDirs.push(artifactsDir);
    const engine = new RpaEngine({
      resolveContext: () => {
        throw new Error('profile is not running');
      },
      artifactsDir,
    });
    const result = await finish(
      engine,
      await engine.run(
        workflow({
          entry: 'wait',
          nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } },
        }),
        ['missing-profile'],
      ),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not running');
  });

  it('外部占用只让对应批量项失败', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'shadowedge-rpa-test-'));
    tempDirs.push(artifactsDir);
    const page = new FakePage();
    const engine = new RpaEngine({
      resolveContext: () => ({ pages: () => [page], newPage: async () => page }),
      artifactsDir,
      profileUnavailable: (profileId) => profileId === 'recording' ? '环境正在录制' : undefined,
    });
    const runs = await engine.run(workflow({
      entry: 'wait', nodes: { wait: { id: 'wait', kind: 'wait', params: { ms: 0 } } },
    }), ['recording', 'available']);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[1]?.status).not.toBe('failed');
    expect(runs[0]?.error).toBe('环境正在录制');
    expect((await engine.wait(runs[1]!.id)).status).toBe('succeeded');
  });
});
