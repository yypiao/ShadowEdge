import { useEffect, useState } from 'react';
import type { RpaNode, RpaNodeKind, RpaWorkflow } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

type SupportedKind = Extract<
  RpaNodeKind,
  'navigate' | 'click' | 'type' | 'wait' | 'extract' | 'screenshot' | 'condition' | 'loop'
>;

const KIND_LABEL: Record<SupportedKind, string> = {
  navigate: '打开页面',
  click: '点击元素',
  type: '输入文本',
  wait: '等待',
  extract: '提取文本',
  screenshot: '截图',
  condition: '条件分支',
  loop: '计数循环',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 7,
  border: '1px solid #d1d5db',
  borderRadius: 5,
  boxSizing: 'border-box',
  fontSize: 12,
  background: '#fff',
};

function defaults(kind: SupportedKind): Record<string, unknown> {
  switch (kind) {
    case 'navigate': return { url: 'https://example.com', waitUntil: 'domcontentloaded' };
    case 'click': return { selector: '#submit' };
    case 'type': return { selector: '#name', text: '{{inputs.name}}' };
    case 'wait': return { ms: 500 };
    case 'extract': return { selector: '#result', key: 'result' };
    case 'screenshot': return { key: 'result', fullPage: true };
    case 'condition': return { left: '{{outputs.result}}', operator: 'exists', right: '' };
    case 'loop': return { count: 3, body: '' };
  }
}

function orderedNodes(workflow: RpaWorkflow): RpaNode[] {
  const nodes: RpaNode[] = [];
  const visited = new Set<string>();
  const visit = (id: string | undefined) => {
    if (!id || visited.has(id)) return;
    const node = workflow.graph.nodes[id];
    if (!node) return;
    visited.add(id);
    nodes.push(node);
    visit(node.next);
    visit(node.elseNext);
    if (node.kind === 'loop' && typeof node.params.body === 'string') visit(node.params.body);
  };
  visit(workflow.graph.entry);
  return nodes;
}

function withNodes(workflow: RpaWorkflow, ordered: RpaNode[]): RpaWorkflow {
  const control = ordered.some((node) => node.kind === 'condition' || node.kind === 'loop');
  const nodes = Object.fromEntries(ordered.map((node, index) => [
    node.id,
    control ? { ...node } : { ...node, next: ordered[index + 1]?.id },
  ]));
  return { ...workflow, graph: { ...workflow.graph, entry: ordered[0]?.id ?? '', nodes } };
}

export function createWorkflowDraft(): RpaWorkflow {
  const node: RpaNode = { id: crypto.randomUUID(), kind: 'navigate', params: defaults('navigate') };
  return {
    id: crypto.randomUUID(),
    orgId: 'local',
    name: '',
    version: 1,
    graph: { entry: node.id, nodes: { [node.id]: node } },
    createdBy: 'local-user',
    updatedAt: new Date().toISOString(),
  };
}

interface Props {
  workflow: RpaWorkflow;
  persisted: boolean;
  onSaved: (workflow: RpaWorkflow) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
}

export function WorkflowEditor({ workflow, persisted, onSaved, onDeleted }: Props) {
  const [draft, setDraft] = useState(workflow);
  const [kind, setKind] = useState<SupportedKind>('click');
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(workflow), [workflow]);

  const nodes = orderedNodes(draft);
  const hasControl = nodes.some((node) => node.kind === 'condition' || node.kind === 'loop');
  const replace = (next: RpaNode[]) => setDraft((current) => withNodes(current, next));
  const updateNode = (id: string, patch: Partial<RpaNode>) => {
    setDraft((current) => ({
      ...current,
      graph: {
        ...current.graph,
        nodes: { ...current.graph.nodes, [id]: { ...current.graph.nodes[id]!, ...patch } },
      },
    }));
  };
  const updateParams = (id: string, patch: Record<string, unknown>) => {
    const node = draft.graph.nodes[id];
    if (node) updateNode(id, { params: { ...node.params, ...patch } });
  };
  const move = (index: number, offset: number) => {
    const next = [...nodes];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    replace(next);
  };

  const appendNode = (node: RpaNode) => {
    if (nodes.length === 0) {
      setDraft((current) => ({ ...current, graph: { ...current.graph, entry: node.id, nodes: { [node.id]: node } } }));
      return;
    }
    if (node.kind === 'loop') {
      const body = nodes.at(-1)!;
      node.params.body = body.id;
      node.next = body.next;
      setDraft((current) => ({
        ...current,
        graph: {
          ...current.graph,
          nodes: {
            ...current.graph.nodes,
            [body.id]: { ...body, next: node.id },
            [node.id]: node,
          },
        },
      }));
      return;
    }
    const tail = [...nodes].reverse().find((candidate) => !candidate.next);
    setDraft((current) => {
      const updated = tail ? {
        ...tail,
        next: node.id,
        ...(tail.kind === 'condition' && !tail.elseNext ? { elseNext: node.id } : {}),
      } : undefined;
      return {
        ...current,
        graph: {
          ...current.graph,
          nodes: {
            ...current.graph.nodes,
            ...(updated ? { [updated.id]: updated } : {}),
            [node.id]: node,
          },
        },
      };
    });
  };

  const save = async () => {
    if (!draft.name.trim() || nodes.length === 0) return;
    setBusy(true);
    try {
      const saved = await window.shadowedge.api['rpa:save']({
        id: draft.id,
        name: draft.name,
        graph: draft.graph,
        inputsSchema: draft.inputsSchema,
      });
      setDraft(saved);
      await onSaved(saved);
      useStore.getState().toast('info', `工作流「${saved.name}」已保存`);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`确定删除工作流「${draft.name}」？运行历史会保留。`)) return;
    setBusy(true);
    try {
      await window.shadowedge.api['rpa:delete'](draft.id);
      await onDeleted(draft.id);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          aria-label="工作流名称"
          placeholder="工作流名称"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          style={{ ...inputStyle, flex: 1, fontSize: 14 }}
        />
        <button type="submit" disabled={busy || !draft.name.trim() || nodes.length === 0}>
          {busy ? '保存中…' : '保存工作流'}
        </button>
        {persisted && <button type="button" disabled={busy} onClick={() => void remove()}>删除</button>}
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 11 }}>
        <label>最大执行步数
          <input type="number" min={1} max={100000} value={draft.graph.maxSteps ?? 10000}
            onChange={(event) => setDraft({ ...draft, graph: { ...draft.graph, maxSteps: event.target.valueAsNumber } })}
            style={{ ...inputStyle, marginTop: 4 }} />
        </label>
        <label>总超时（毫秒）
          <input type="number" min={1} max={3600000} value={draft.graph.timeoutMs ?? 300000}
            onChange={(event) => setDraft({ ...draft, graph: { ...draft.graph, timeoutMs: event.target.valueAsNumber } })}
            style={{ ...inputStyle, marginTop: 4 }} />
        </label>
      </div>

      <div style={{ color: '#777', fontSize: 11, marginBottom: 12 }}>
        版本 {draft.version} · 支持分支/有限循环 · 变量：{'{{inputs.name}}'}、{'{{outputs.result}}'}、{'{{loop.节点ID.index}}'}
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {nodes.map((node, index) => (
          <section
            key={node.id}
            data-node-id={node.id}
            data-node-kind={node.kind}
            style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <strong style={{ fontSize: 12, flex: 1 }}>{index + 1}. {KIND_LABEL[node.kind as SupportedKind]}</strong>
              <button type="button" aria-label={`上移节点 ${index + 1}`} disabled={hasControl || index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={`下移节点 ${index + 1}`} disabled={hasControl || index === nodes.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={`删除节点 ${index + 1}`} disabled={hasControl && nodes.length > 1} onClick={() => replace(nodes.filter((item) => item.id !== node.id))}>×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {node.kind === 'navigate' && (
                <>
                  <label style={{ gridColumn: '1 / -1', fontSize: 11 }}>页面 URL
                    <input value={String(node.params.url ?? '')} onChange={(e) => updateParams(node.id, { url: e.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>等待条件
                    <select value={String(node.params.waitUntil ?? 'domcontentloaded')} onChange={(e) => updateParams(node.id, { waitUntil: e.target.value })} style={{ ...inputStyle, marginTop: 4 }}>
                      <option value="domcontentloaded">DOM 就绪</option>
                      <option value="load">页面加载完成</option>
                      <option value="networkidle">网络空闲</option>
                    </select>
                  </label>
                </>
              )}
              {(node.kind === 'click' || node.kind === 'type' || node.kind === 'extract') && (
                <label style={{ fontSize: 11 }}>CSS 选择器
                  <input value={String(node.params.selector ?? '')} onChange={(e) => updateParams(node.id, { selector: e.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
                </label>
              )}
              {node.kind === 'type' && (
                <label style={{ fontSize: 11 }}>输入内容
                  <input value={String(node.params.text ?? '')} onChange={(e) => updateParams(node.id, { text: e.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
                </label>
              )}
              {node.kind === 'wait' && (
                <label style={{ fontSize: 11 }}>等待毫秒
                  <input type="number" min={0} value={Number(node.params.ms ?? 0)} onChange={(e) => updateParams(node.id, { ms: e.target.valueAsNumber })} style={{ ...inputStyle, marginTop: 4 }} />
                </label>
              )}
              {(node.kind === 'extract' || node.kind === 'screenshot') && (
                <label style={{ fontSize: 11 }}>结果名称
                  <input value={String(node.params.key ?? '')} onChange={(e) => updateParams(node.id, { key: e.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
                </label>
              )}
              {node.kind === 'condition' && (
                <>
                  <label style={{ fontSize: 11 }}>左侧值
                    <input aria-label={`条件左侧 ${index + 1}`} value={String(node.params.left ?? '')} onChange={(event) => updateParams(node.id, { left: event.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>比较方式
                    <select value={String(node.params.operator ?? 'equals')} onChange={(event) => updateParams(node.id, { operator: event.target.value })} style={{ ...inputStyle, marginTop: 4 }}>
                      <option value="equals">等于</option><option value="notEquals">不等于</option>
                      <option value="contains">包含</option><option value="notContains">不包含</option>
                      <option value="exists">非空</option><option value="notExists">为空</option>
                      <option value="greaterThan">大于</option><option value="lessThan">小于</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>右侧值
                    <input value={String(node.params.right ?? '')} onChange={(event) => updateParams(node.id, { right: event.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
                  </label>
                  {(['next', 'elseNext'] as const).map((field) => (
                    <label key={field} style={{ fontSize: 11 }}>{field === 'next' ? '条件成立前往' : '条件不成立前往'}
                      <select value={node[field] ?? ''} onChange={(event) => updateNode(node.id, { [field]: event.target.value || undefined })} style={{ ...inputStyle, marginTop: 4 }}>
                        <option value="">结束运行</option>
                        {nodes.filter((target) => target.id !== node.id).map((target) => <option key={target.id} value={target.id}>{target.id}</option>)}
                      </select>
                    </label>
                  ))}
                </>
              )}
              {node.kind === 'loop' && (
                <>
                  <label style={{ fontSize: 11 }}>循环次数
                    <input aria-label={`循环次数 ${index + 1}`} type="number" min={0} max={1000} value={Number(node.params.count ?? 3)} onChange={(event) => updateParams(node.id, { count: event.target.valueAsNumber })} style={{ ...inputStyle, marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>循环体起始节点
                    <select value={String(node.params.body ?? '')} onChange={(event) => updateParams(node.id, { body: event.target.value })} style={{ ...inputStyle, marginTop: 4 }}>
                      {nodes.filter((target) => target.id !== node.id).map((target) => <option key={target.id} value={target.id}>{target.id}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>循环结束前往
                    <select value={node.next ?? ''} onChange={(event) => updateNode(node.id, { next: event.target.value || undefined })} style={{ ...inputStyle, marginTop: 4 }}>
                      <option value="">结束运行</option>
                      {nodes.filter((target) => target.id !== node.id).map((target) => <option key={target.id} value={target.id}>{target.id}</option>)}
                    </select>
                  </label>
                  <p style={{ gridColumn: '1 / -1', color: '#777', fontSize: 11 }}>循环体末尾必须回到本循环节点；当前索引变量为 {'{{loop.'}{node.id}{'.index}}'}。</p>
                </>
              )}
              <label style={{ fontSize: 11 }}>失败处理
                <select value={node.onError ?? 'stop'} onChange={(e) => updateNode(node.id, { onError: e.target.value as RpaNode['onError'] })} style={{ ...inputStyle, marginTop: 4 }}>
                  <option value="stop">停止运行</option>
                  <option value="continue">继续下一节点</option>
                  <option value="retry">重试</option>
                </select>
              </label>
              {node.onError === 'retry' && (
                <label style={{ fontSize: 11 }}>重试次数
                  <input type="number" min={0} value={node.retries ?? 1} onChange={(e) => updateNode(node.id, { retries: e.target.valueAsNumber })} style={{ ...inputStyle, marginTop: 4 }} />
                </label>
              )}
            </div>
          </section>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <select aria-label="待添加节点类型" value={kind} onChange={(e) => setKind(e.target.value as SupportedKind)} style={inputStyle}>
          {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => {
            const node: RpaNode = { id: crypto.randomUUID(), kind, params: defaults(kind) };
            appendNode(node);
          }}
          disabled={kind === 'loop' && nodes.length === 0}
        >添加节点</button>
      </div>
    </form>
  );
}
