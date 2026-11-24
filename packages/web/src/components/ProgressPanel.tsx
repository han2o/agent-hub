import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  RotateCcw,
  XCircle
} from 'lucide-react';
import type {
  HandoffJobRecord,
  HandoffStepRecord,
  ProgressSnapshot,
  SessionRecord
} from '../api/types';

interface ProgressPanelProps {
  session: SessionRecord | null;
  progress: ProgressSnapshot | null;
  relatedHandoff: HandoffJobRecord | null;
  onRetryHandoff: (jobId: string) => void;
}

const STEP_LABELS: Record<HandoffStepRecord['stepName'], string> = {
  FREEZE_SOURCE: '1. 冻结 Mac 会话并刷盘',
  SYNC_WORKSPACE: '2. 提交并推送 Git WIP 分支',
  EXPORT_SESSION: '3. 打包导出单会话上下文',
  PREPARE_TARGET_REPO: '4. Mini 定位仓库 / Worktree 检出',
  IMPORT_SESSION: '5. 路径改写并导入 Mini 会话',
  RESUME_TARGET: '6. Mini 原权限 Resume 与续跑',
  FINALIZE: '7. 标记交接完成并切换焦点'
};

function StepIcon({ status }: { status: HandoffStepRecord['status'] }) {
  if (status === 'SUCCEEDED') return <CheckCircle2 size={14} color="#22c55e" />;
  if (status === 'FAILED') return <XCircle size={14} color="#ef4444" />;
  if (status === 'RUNNING') {
    return <Loader2 size={14} color="#a855f7" />;
  }
  return <Circle size={14} color="#64738f" />;
}

export function ProgressPanel({
  session,
  progress,
  relatedHandoff,
  onRetryHandoff
}: ProgressPanelProps) {
  if (!session) {
    return (
      <aside className="progress-panel">
        <div className="panel-section">
          <div className="panel-title">运行概览</div>
          <div style={{ color: 'var(--text-secondary)' }}>
            选中左侧会话后，可在此查看结构化进度、审批提示、Git 分支与 7 步移交状态机。
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="progress-panel">
      {(progress?.approvalPrompt || session.approvalPrompt) && (
        <div className="approval-banner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, marginBottom: 4 }}>
            <AlertTriangle size={14} />
            等待终端审批确认
          </div>
          <div>{progress?.approvalPrompt || session.approvalPrompt}</div>
        </div>
      )}

      <div className="panel-section">
        <div className="panel-title">会话元数据</div>
        <div className="kv-row">
          <span className="kv-label">节点</span>
          <span className="kv-val">{session.nodeId}</span>
        </div>
        <div className="kv-row">
          <span className="kv-label">Agent</span>
          <span className="kv-val">{session.agent}</span>
        </div>
        <div className="kv-row">
          <span className="kv-label">权限模式</span>
          <span className="kv-val">{session.permissionMode}</span>
        </div>
        <div className="kv-row">
          <span className="kv-label">工作目录</span>
          <span className="kv-val">{session.cwd}</span>
        </div>
        {session.gitBranch && (
          <div className="kv-row">
            <span className="kv-label">Git 分支</span>
            <span className="kv-val">{session.gitBranch}</span>
          </div>
        )}
        {session.worktreePath && (
          <div className="kv-row">
            <span className="kv-label">隔离 Worktree</span>
            <span className="kv-val">{session.worktreePath}</span>
          </div>
        )}
        {session.externalSessionId && (
          <div className="kv-row">
            <span className="kv-label">原生会话 ID</span>
            <span className="kv-val">{session.externalSessionId.slice(0, 14)}…</span>
          </div>
        )}
      </div>

      {relatedHandoff && (
        <div className="panel-section">
          <div className="panel-title">
            <span>移交 Saga 状态 ({relatedHandoff.status})</span>
            {relatedHandoff.status === 'FAILED' && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onRetryHandoff(relatedHandoff.id)}
              >
                <RotateCcw size={12} />
                断点重试
              </button>
            )}
          </div>

          {relatedHandoff.wipBranch && (
            <div className="kv-row">
              <span className="kv-label">WIP 分支</span>
              <span className="kv-val">{relatedHandoff.wipBranch}</span>
            </div>
          )}
          {relatedHandoff.fallbackUsed && (
            <div style={{ fontSize: 12, color: '#fde68a' }}>
              已自动触发 agy 降级上下文续跑模式
            </div>
          )}
          {relatedHandoff.errorMessage && (
            <div className="error-box">{relatedHandoff.errorMessage}</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            {relatedHandoff.steps.map((step) => (
              <div key={step.stepName} className="saga-step">
                <div style={{ paddingTop: 2 }}>
                  <StepIcon status={step.status} />
                </div>
                <div className="saga-step-body">
                  <div style={{ fontWeight: 600 }}>
                    {STEP_LABELS[step.stepName] || step.stepName}
                  </div>
                  {step.message && (
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {step.message}
                    </div>
                  )}
                  {(step.stderrTail || step.stdoutTail) && (
                    <div className="saga-log">
                      {step.stderrTail || step.stdoutTail}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel-section">
        <div className="panel-title">
          <span>实时进展轨迹</span>
          <span>{progress?.stepCount ?? 0} 步</span>
        </div>
        {!progress || progress.events.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            暂无结构化事件，可直接在左侧终端中交互查看实时输出。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {progress.events.slice(-8).reverse().map((ev, idx) => (
              <div key={`${ev.timestamp}-${idx}`} className="event-item">
                <div className="event-title">
                  [{ev.kind}] {ev.title}
                </div>
                <div className="event-detail">{ev.detail}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
