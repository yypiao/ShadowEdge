import { useEffect, useState } from 'react';
import type { RpaNode, RpaNodeKind, RpaWorkflow } from '@shadowedge/core';
import { toastError, useStore } from '../store.js';

type SupportedKind = Extract<
  RpaNodeKind,
  'navigate' | 'click' | 'type' | 'wait' | 'extract' | 'screenshot'
>;

const KIND_LABEL: Record<SupportedKind, string> = {
  navigate: '打开页面',
  click: '点击元素',
  type: '输入文本',
  wait: '等待',
  extract: '提取文本',
  screenshot: '截图',
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
  }
}

function orderedNodes(workflow: RpaWorkflow): RpaNode[] {
  const nodes: RpaNode[] = [];
  const visited = new Set<string>();
  let id: string | undefined = workflow.graph.entry;
  while (id && workflow.graph.nodes[id] && !visited.has(id)) {
    visited.add(id);
    nodes.push(workflow.graph.nodes[id]!);
    id = workflow.graph.nodes[id]!.next;
  }
  return nodes;
}

function withNodes(workflow: RpaWorkflow, ordered: RpaNode[]): RpaWorkflow {
  const nodes = Object.fromEntries(ordered.map((node, index) => [
    node.id,
    { ...node, next: ordered[index + 1]?.id },
  ]));
  return { ...workflow, graph: { entry: ordered[0]?.id ?? '', nodes } };
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
  const replace = (next: RpaNode[]) => setDraft((current) => withNodes(current, next));
  const updateNode = (id: string, patch: Partial<RpaNode>) => {
    replace(nodes.map((node) => node.id === id ? { ...node, ...patch } : node));
  };
  const updateParams = (id: string, patch: Record<string, unknown>) => {
    replace(nodes.map((node) => node.id === id
      ? { ...node, params: { ...node.params, ...patch } }
      : node));
  };
  const move = (index: number, offset: number) => {
    const next = [...nodes];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    replace(next);
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
      <div style={{ color: '#777', fontSize: 11, marginBottom: 12 }}>
        版本 {draft.version} · 按顺序执行 · 输入文本可使用 {'{{inputs.name}}'} 变量
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
              <button type="button" aria-label={`上移节点 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={`下移节点 ${index + 1}`} disabled={index === nodes.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={`删除节点 ${index + 1}`} onClick={() => replace(nodes.filter((item) => item.id !== node.id))}>×</button>
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
            replace([...nodes, node]);
          }}
        >添加节点</button>
      </div>
    </form>
  );
}
