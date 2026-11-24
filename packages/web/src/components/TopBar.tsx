import {
  ArrowRightLeft,
  Bell,
  BellOff,
  KeyRound,
  Plus,
  TerminalSquare
} from 'lucide-react';
import type { NodeInfo } from '../api/types';

interface TopBarProps {
  nodes: NodeInfo[];
  wsConnected: boolean;
  activeMacCount: number;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onConfigureToken: () => void;
  onOpenNewSession: () => void;
  onOpenBulkHandoff: () => void;
}

export function TopBar({
  nodes,
  wsConnected,
  activeMacCount,
  notificationsEnabled,
  onToggleNotifications,
  onConfigureToken,
  onOpenNewSession,
  onOpenBulkHandoff
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand">
          <div className="brand-icon">
            <TerminalSquare size={16} />
          </div>
          <span>Agent Hub</span>
        </div>

        <div className="node-pills">
          {nodes.map((node) => (
            <div key={node.id} className="node-pill" title={`${node.homeDir} (${node.os})`}>
              <span
                className={`dot ${node.status === 'ONLINE' ? 'online' : 'offline'}`}
              />
              <span>{node.name}</span>
              {node.role === 'hub' && <span className="tag-default">默认</span>}
            </div>
          ))}
          <div className="node-pill" title="实时事件通道状态">
            <span className={`dot ${wsConnected ? 'online' : 'offline'}`} />
            <span>{wsConnected ? 'WS 已连接' : '重连中'}</span>
          </div>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onConfigureToken}
          title="设置共享认证 Token"
        >
          <KeyRound size={14} />
          Token
        </button>

        <button
          type="button"
          className="btn btn-sm"
          onClick={onToggleNotifications}
          title="审批弹窗桌面提醒"
        >
          {notificationsEnabled ? <Bell size={14} /> : <BellOff size={14} />}
          提醒
        </button>

        <button
          type="button"
          className="btn btn-handoff"
          disabled={activeMacCount === 0}
          onClick={onOpenBulkHandoff}
        >
          <ArrowRightLeft size={14} />
          下班模式：全部移交 Mini
          {activeMacCount > 0 && (
            <span className="badge-count">{activeMacCount}</span>
          )}
        </button>

        <button
          type="button"
          className="btn btn-primary"
          onClick={onOpenNewSession}
        >
          <Plus size={15} />
          新建 / 恢复会话
        </button>
      </div>
    </header>
  );
}
