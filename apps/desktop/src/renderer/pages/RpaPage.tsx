import { useCallback, useEffect, useState } from 'react';
import type { RpaRun, RpaWorkflow } from '@shadowedge/core';
import { createWorkflowDraft, WorkflowEditor } from '../components/WorkflowEditor.js';
import { toastError, useStore } from '../store.js';

const STATUS_LABEL: Record<RpaRun['status'], string> = {
  queued: '等待中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消',
};

export function RpaPage() {
  const { profiles } = useStore();
  const [workflows, setWorkflows] = useState<RpaWorkflow[]>([]);
  const [draft, setDraft] = useState<RpaWorkflow>(() => createWorkflowDraft());
  const [runs, setRuns] = useState<RpaRun[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<Set<string>>(new Set());
  const [inputsText, setInputsText] = useState('{\n  "name": "Ada"\n}');
  const [progress, setProgress] = useState<Record<string, { step: string; percent: number }>>({});
  const [submitting, setSubmitting] = useState(false);

  const refreshRuns = useCallback(async () => {
    setRuns(await window.shadowedge.api['rpa:listRuns']({ limit: 100 }));
  }, []);
  const refreshWorkflows = useCallback(async () => {
    setWorkflows(await window.shadowedge.api['rpa:list'](undefined));
  }, []);

  useEffect(() => {
    void refreshWorkflows().catch(toastError);
    void refreshRuns().catch(toastError);
    return window.shadowedge.on['rpa:progress']((event) => {
      setProgress((current) => ({
        ...current,
        [event.runId]: { step: event.step, percent: event.percent },
      }));
    });
  }, [refreshRuns, refreshWorkflows]);

  const hasActive = runs.some((run) => run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void refreshRuns().catch(toastError), 500);
    return () => clearInterval(timer);
  }, [hasActive, refreshRuns]);

  const runningProfiles = profiles.filter((profile) => profile.status === 'running');
  const runnableProfileIds = runningProfiles
    .filter((profile) => selectedProfiles.has(profile.id))
    .map((profile) => profile.id);
  const run = async () => {
    if (runnableProfileIds.length === 0) return;
    let inputs: unknown;
    try {
      inputs = inputsText.trim() ? JSON.parse(inputsText) : {};
      if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
        throw new Error('输入参数必须是 JSON 对象');
      }
    } catch (error) {
      toastError(error);
      return;
    }
    setSubmitting(true);
    try {
      await window.shadowedge.api['rpa:run']({
        workflow: draft,
        profileIds: runnableProfileIds,
        inputs,
      });
      await refreshRuns();
      useStore.getState().toast('info', 'RPA 运行已提交');
    } catch (error) {
      toastError(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>自动化工作流</h2>
        <button type="button" onClick={() => setDraft(createWorkflowDraft())}>新建工作流</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '230px minmax(420px, 1fr)', gap: 16 }}>
        <aside style={{ borderRight: '1px solid #e5e7eb', paddingRight: 12 }}>
          <strong style={{ fontSize: 13 }}>已保存 {workflows.length} 个</strong>
          <div style={{ display: 'grid', gap: 4, marginTop: 10 }}>
            {workflows.map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                onClick={() => setDraft(workflow)}
                style={{
                  textAlign: 'left', padding: 8, border: 0, borderRadius: 5, cursor: 'pointer',
                  background: draft.id === workflow.id ? '#e8f1fb' : 'transparent',
                }}
              >
                <div style={{ fontSize: 12 }}>{workflow.name}</div>
                <div style={{ fontSize: 10, color: '#777', marginTop: 3 }}>v{workflow.version}</div>
              </button>
            ))}
          </div>
        </aside>
        <WorkflowEditor
          workflow={draft}
          persisted={workflows.some((workflow) => workflow.id === draft.id)}
          onSaved={async (saved) => {
            setDraft(saved);
            await refreshWorkflows();
          }}
          onDeleted={async () => {
            setDraft(createWorkflowDraft());
            await refreshWorkflows();
          }}
        />
      </div>

      <section style={{ borderTop: '1px solid #e5e7eb', marginTop: 20, paddingTop: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>运行当前工作流</h3>
        {runningProfiles.length === 0 ? (
          <p style={{ color: '#888', fontSize: 12 }}>请先在环境管理中启动至少一个环境。</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12 }}>
            {runningProfiles.map((profile) => (
              <label key={profile.id}>
                <input
                  aria-label={`运行环境 ${profile.name}`}
                  type="checkbox"
                  checked={selectedProfiles.has(profile.id)}
                  onChange={() => setSelectedProfiles((current) => {
                    const next = new Set(current);
                    if (next.has(profile.id)) next.delete(profile.id);
                    else next.add(profile.id);
                    return next;
                  })}
                /> {profile.name}
              </label>
            ))}
          </div>
        )}
        <label style={{ display: 'block', marginTop: 10, fontSize: 11 }}>输入参数（JSON 对象）
          <textarea
            value={inputsText}
            onChange={(event) => setInputsText(event.target.value)}
            rows={3}
            style={{ width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 11, boxSizing: 'border-box' }}
          />
        </label>
        <button type="button" disabled={submitting || runnableProfileIds.length === 0 || !draft.name.trim()} onClick={() => void run()}>
          {submitting ? '提交中…' : '运行工作流'}
        </button>
      </section>

      <section style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 15 }}>最近运行</h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {runs.map((item) => {
            const workflow = workflows.find((candidate) => candidate.id === item.workflowId);
            const profile = profiles.find((candidate) => candidate.id === item.profileId);
            const currentProgress = progress[item.id];
            const active = item.status === 'queued' || item.status === 'running';
            return (
              <article key={item.id} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <strong style={{ flex: 1 }}>{workflow?.name ?? item.workflowId}</strong>
                  <span>{profile?.name ?? item.profileId}</span>
                  <strong>{STATUS_LABEL[item.status]}</strong>
                  {active && (
                    <button type="button" onClick={() => void window.shadowedge.api['rpa:cancel'](item.id).then(refreshRuns).catch(toastError)}>取消运行</button>
                  )}
                </div>
                {active && <progress aria-label={`运行进度 ${item.id}`} max={100} value={currentProgress?.percent ?? 0} style={{ width: '100%', marginTop: 8 }} />}
                {item.error && <div style={{ color: '#d32f2f', fontSize: 11, marginTop: 6 }}>{item.error}</div>}
                {item.outputs && Object.keys(item.outputs).length > 0 && (
                  <pre style={{ background: '#f6f8fa', padding: 8, fontSize: 11, overflow: 'auto' }}>{JSON.stringify(item.outputs, null, 2)}</pre>
                )}
                {item.artifacts.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {item.artifacts.map((artifact) => {
                      const name = artifact.uri.split(/[\\/]/).pop();
                      return <button key={artifact.uri} type="button" onClick={() => void window.shadowedge.api['rpa:openArtifact']({ runId: item.id, uri: artifact.uri }).catch(toastError)}>打开 {name}</button>;
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
