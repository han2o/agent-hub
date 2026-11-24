import { ArrowRightLeft, Trash2 } from 'lucide-react';
import type { AgentKind, NodeInfo, SessionRecord } from '../api/types';

interface SessionSidebarProps {
  nodes: NodeInfo[];
  sessions: SessionRecord[];
  selectedSessionId: string | null;
  nodeFilter: string;
  agentFilter: AgentKind | 'all';
  onNodeFilterChange: (nodeId: string) => void;
  onAgentFilterChange: (agent: AgentKind | 'all') => void;
  onSelectSession: (id: string) => void;
  onHandoffSession: (id: string) => void;
  onStopSession: (id: string) => void;
}

const AGENTS: Array<{ value: AgentKind | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'agy', label: 'agy' },
  { value: 'pi', label: 'pi' },
  { value: 'claude', label: 'claude' },
  { value: 'qodercli', label: 'qoder' }
];

const STATE_LABEL: Record<SessionRecord['state'], string> = {
  RUNNING: '运行中',
  WAITING_APPROVAL: '待审批',
  IDLE: '空闲',
  HANDING_OFF: '移交中',
  HANDED_OFF: '已移交',
  EXITED: '已结束',
  ERROR: '异常'
};

export function SessionSidebar({
  nodes,
  sessions,
  selectedSessionId,
  nodeFilter,
  agentFilter,
  onNodeFilterChange,
  onAgentFilterChange,
  onSelectSession,
  onHandoffSession,
  onStopSession
}: SessionSidebarProps) {
  const nodeRoleMap = new Map(nodes.map((n) => [n.id, n.role]));

  const filtered = sessions.filter((s) => {
    if (nodeFilter !== 'all' && s.nodeId !== nodeFilter) return false;
    if (agentFilter !== 'all' && s.agent !== agentFilter) return false;
    return true;
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-filters">
        <div className="tab-row">
          <button
            type="button"
            className={`filter-chip ${nodeFilter === 'all' ? 'active' : ''}`}
            onClick={() => onNodeFilterChange('all')}
          >
            全部机器
          </button>
          {nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`filter-chip ${nodeFilter === n.id ? 'active' : ''}`}
              onClick={() => onNodeFilterChange(n.id)}
            >
              {n.id}
            </button>
          ))}
        </div>

        <div className="tab-row">
          {AGENTS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`filter-chip ${agentFilter === a.value ? 'active' : ''}`}
              onClick={() => onAgentFilterChange(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="session-list">
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>
            <div>暂无匹配的会话</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              点击右上角「新建 / 恢复会话」默认在 Mini 启动
            </div>
          </div>
        ) : (
          filtered.map((session) => {
            const isCompanion = nodeRoleMap.get(session.nodeId) === 'companion';
            const canHandoff =
              isCompanion &&
              (session.state === 'RUNNING' ||
                session.state === 'WAITING_APPROVAL' ||
                session.state === 'IDLE');

            return (
              <div
                key={session.id}
                className={`session-card ${selectedSessionId === session.id ? 'selected' : ''}`}
                onClick={() => onSelectSession(session.id)}
              >
                <div className="session-card-head">
                  <span className="agent-badge">{session.agent}</span>
                  <span className={`node-tag ${isCompanion ? 'mac' : ''}`}>
                    {session.nodeId}
                  </span>
                  <span className="session-title">{session.title}</span>
                </div>

                <div className="session-preview">
                  {session.approvalPrompt
                    ? `⚠ ${session.approvalPrompt}`
                    : session.latestSummary || '等待输出...'}
                </div>

                <div className="session-cwd" title={session.cwd}>
                  {session.cwd}
                </div>

                <div className="session-card-footer">
                  <span className={`state-pill state-${session.state}`}>
                    {session.state === 'RUNNING' && <span className="dot pulse" />}
                    {STATE_LABEL[session.state]}
                  </span>

                  <div
                    style={{ display: 'flex', gap: 4 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canHandoff && (
                      <button
                        type="button"
                        className="btn btn-sm btn-handoff"
                        title="移交给 Mini 接管继续"
                        onClick={() => onHandoffSession(session.id)}
                      >
                        <ArrowRightLeft size={12} />
                        移交 Mini
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      title={
                        session.state === 'EXITED' || session.state === 'HANDED_OFF'
                          ? '清除记录'
                          : '停止会话'
                      }
                      onClick={() => onStopSession(session.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
