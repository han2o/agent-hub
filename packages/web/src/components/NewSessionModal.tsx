import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { hubApi } from '../api/client';
import type {
  AgentKind,
  DiscoveredSession,
  NodeInfo,
  PermissionMode,
  RepoInfo,
  SessionRecord
} from '../api/types';

interface NewSessionModalProps {
  open: boolean;
  nodes: NodeInfo[];
  onClose: () => void;
  onCreated: (session: SessionRecord) => void;
}

export function NewSessionModal({
  open,
  nodes,
  onClose,
  onCreated
}: NewSessionModalProps) {
  const defaultNode = nodes.find((n) => n.role === 'hub')?.id || nodes[0]?.id || 'mini';
  const [mode, setMode] = useState<'start' | 'resume'>('start');
  const [nodeId, setNodeId] = useState<string>(defaultNode);
  const [agent, setAgent] = useState<AgentKind>('pi');
  const [cwd, setCwd] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [model, setModel] = useState<string>('');
  const [initialPrompt, setInitialPrompt] = useState<string>('');
  const [extraArgsText, setExtraArgsText] = useState<string>('');

  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredSession[]>([]);
  const [selectedDiscovered, setSelectedDiscovered] = useState<DiscoveredSession | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNodeId(defaultNode);
    setError(null);
  }, [open, defaultNode]);

  useEffect(() => {
    if (!open || !nodeId) return;
    let cancelled = false;
    setLoadingList(true);

    Promise.all([
      hubApi.getWorkspaces(nodeId).catch(() => []),
      mode === 'resume'
        ? hubApi.discoverSessions(nodeId, agent).catch(() => [])
        : Promise.resolve([])
    ])
      .then(([repoList, discList]) => {
        if (cancelled) return;
        setRepos(repoList);
        if (!cwd && repoList.length > 0) {
          setCwd(repoList[0].path);
        }
        setDiscovered(discList);
        if (discList.length > 0) {
          setSelectedDiscovered(discList[0]);
          if (discList[0].cwd) setCwd(discList[0].cwd);
        } else {
          setSelectedDiscovered(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, nodeId, agent, mode]);

  if (!open) return null;

  const currentNode = nodes.find((n) => n.id === nodeId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const targetCwd = cwd.trim() || currentNode?.homeDir || '';
    if (!targetCwd) {
      setError('请填写或选择工作目录');
      return;
    }
    const extraArgs = extraArgsText
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    setSubmitting(true);
    try {
      let created: SessionRecord;
      if (mode === 'start') {
        created = await hubApi.startSession({
          nodeId,
          agent,
          cwd: targetCwd,
          title: title.trim() || undefined,
          permissionMode,
          model: model.trim() || undefined,
          initialPrompt: initialPrompt.trim() || undefined,
          extraArgs
        });
      } else {
        if (!selectedDiscovered) {
          throw new Error('请选择要恢复的历史会话');
        }
        created = await hubApi.resumeSession({
          nodeId,
          agent,
          externalSessionId: selectedDiscovered.externalSessionId,
          sessionFilePath: selectedDiscovered.filePath,
          cwd: targetCwd,
          title: title.trim() || selectedDiscovered.title,
          permissionMode,
          model: model.trim() || undefined,
          extraArgs
        });
      }
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <div className="modal-head">
          <div className="modal-title">发起 / 恢复 Agent 会话</div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="tab-row">
          <button
            type="button"
            className={`filter-chip ${mode === 'start' ? 'active' : ''}`}
            onClick={() => setMode('start')}
          >
            新建会话 (Start)
          </button>
          <button
            type="button"
            className={`filter-chip ${mode === 'resume' ? 'active' : ''}`}
            onClick={() => setMode('resume')}
          >
            恢复历史会话 (Resume)
          </button>
        </div>

        <div className="grid-2">
          <div className="form-group">
            <label className="form-label">目标执行节点（默认 Mini）</label>
            <select
              className="form-select"
              value={nodeId}
              onChange={(e) => {
                setNodeId(e.target.value);
                setCwd('');
              }}
            >
              {nodes.map((n) => (
                <option key={n.id} value={n.id} disabled={n.status === 'OFFLINE'}>
                  {n.name} ({n.id}) {n.role === 'hub' ? '· 默认主力' : ''}
                  {n.status === 'OFFLINE' ? ' [离线]' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">选择 Agent</label>
            <select
              className="form-select"
              value={agent}
              onChange={(e) => setAgent(e.target.value as AgentKind)}
            >
              <option value="pi">pi (pi-agent)</option>
              <option value="agy">agy (Antigravity CLI)</option>
              <option value="claude">claude (Claude Code)</option>
              <option value="qodercli">qodercli (Qoder CLI)</option>
            </select>
          </div>
        </div>

        {mode === 'resume' && (
          <div className="form-group">
            <label className="form-label">
              节点 {nodeId} 上的 {agent} 历史会话 {loadingList ? '(加载中...)' : ''}
            </label>
            <div className="discovered-list">
              {discovered.length === 0 ? (
                <div style={{ padding: 10, color: 'var(--text-muted)' }}>
                  {loadingList ? '正在扫描磁盘会话...' : '未发现可恢复的历史会话'}
                </div>
              ) : (
                discovered.map((item) => (
                  <div
                    key={item.externalSessionId}
                    className={`discovered-item ${
                      selectedDiscovered?.externalSessionId === item.externalSessionId
                        ? 'selected'
                        : ''
                    }`}
                    onClick={() => {
                      setSelectedDiscovered(item);
                      if (item.cwd) setCwd(item.cwd);
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{item.title}</div>
                    <div className="session-preview">{item.preview}</div>
                    <div className="session-cwd">{item.cwd || item.filePath}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">工作目录 (CWD)</label>
          {repos.length > 0 && (
            <select
              className="form-select"
              value={repos.some((r) => r.path === cwd) ? cwd : ''}
              onChange={(e) => {
                if (e.target.value) setCwd(e.target.value);
              }}
            >
              <option value="">-- 从节点已扫描仓库中选择 --</option>
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name} ({r.branch || 'git'}) — {r.path}
                </option>
              ))}
            </select>
          )}
          <input
            className="form-input"
            placeholder={currentNode?.homeDir ? `${currentNode.homeDir}/Workspace/...` : '/Users/...'}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
        </div>

        <div className="grid-2">
          <div className="form-group">
            <label className="form-label">权限模式</label>
            <select
              className="form-select"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
            >
              <option value="default">default（默认确认）</option>
              <option value="accept_edits">accept_edits（自动允许编辑）</option>
              <option value="auto">auto（自动决策）</option>
              <option value="plan">plan（规划模式）</option>
              <option value="bypass">bypass（跳过权限确认）</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">自定义模型（可选）</label>
            <input
              className="form-input"
              placeholder="留空使用默认模型"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="form-group">
            <label className="form-label">会话标题（可选）</label>
            <input
              className="form-input"
              placeholder="例如：修复支付回调重试逻辑"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">附加 CLI 参数（可选）</label>
            <input
              className="form-input"
              placeholder="例如：--thinking high"
              value={extraArgsText}
              onChange={(e) => setExtraArgsText(e.target.value)}
            />
          </div>
        </div>

        {mode === 'start' && (
          <div className="form-group">
            <label className="form-label">初始任务提示词（可选）</label>
            <textarea
              className="form-textarea"
              rows={3}
              placeholder="输入首条指令，或者留空直接进入交互终端..."
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
            />
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '启动中...' : mode === 'start' ? '启动会话' : '恢复会话'}
          </button>
        </div>
      </form>
    </div>
  );
}
