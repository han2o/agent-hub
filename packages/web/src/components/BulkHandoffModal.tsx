import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { hubApi } from '../api/client';
import type { HandoffJobRecord, SessionRecord } from '../api/types';

interface BulkHandoffModalProps {
  open: boolean;
  macSessions: SessionRecord[];
  handoffs: HandoffJobRecord[];
  onClose: () => void;
}

export function BulkHandoffModal({
  open,
  macSessions,
  handoffs,
  onClose
}: BulkHandoffModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchJobIds, setBatchJobIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedIds(macSessions.map((s) => s.id));
      setBatchJobIds([]);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const toggleId = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleTriggerBatch = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await hubApi.startBatchHandoff(selectedIds);
      setBatchJobIds(res.jobs.map((j) => j.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const activeJobs = handoffs.filter((j) => batchJobIds.includes(j.id));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ArrowRightLeft size={18} color="#a855f7" />
            下班模式：全部移交 Mini 接管
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
          移交流程将对每个勾选的 Mac 会话自动执行：优雅暂停并刷盘 → 提交并推送临时 Git WIP 分支到 origin → Mini 自动定位仓库（脏仓库自动隔离 Worktree）→ 导入改写路径后的会话 → 原权限续跑。
        </div>

        {batchJobIds.length === 0 ? (
          <div className="discovered-list" style={{ maxHeight: 280 }}>
            {macSessions.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-muted)' }}>
                当前 Mac 上没有活跃会话需要移交。
              </div>
            ) : (
              macSessions.map((s) => (
                <label
                  key={s.id}
                  className="discovered-item"
                  style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(s.id)}
                    onChange={() => toggleId(s.id)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className="agent-badge">{s.agent}</span>
                      <span style={{ fontWeight: 600 }}>{s.title}</span>
                      <span className={`state-pill state-${s.state}`}>{s.state}</span>
                    </div>
                    <div className="session-cwd">{s.cwd}</div>
                  </div>
                </label>
              ))
            )}
          </div>
        ) : (
          <div className="discovered-list" style={{ maxHeight: 300 }}>
            {activeJobs.map((job) => (
              <div key={job.id} className="discovered-item">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {job.status === 'SUCCEEDED' && <CheckCircle2 size={15} color="#22c55e" />}
                    {job.status === 'FAILED' && <XCircle size={15} color="#ef4444" />}
                    {job.status === 'RUNNING' && <Loader2 size={15} color="#a855f7" />}
                    <span className="agent-badge">{job.agent}</span>
                    <strong>{job.sourceCwd}</strong>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {job.phase} · {job.status}
                  </span>
                </div>
                {job.errorMessage && (
                  <div className="error-box" style={{ marginTop: 6 }}>
                    {job.errorMessage}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          {batchJobIds.length === 0 && (
            <button
              type="button"
              className="btn btn-handoff"
              disabled={selectedIds.length === 0 || submitting}
              onClick={() => void handleTriggerBatch()}
            >
              {submitting ? '正在批量移交...' : `确认移交 (${selectedIds.length})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
