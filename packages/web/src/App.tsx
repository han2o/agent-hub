import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getAuthToken,
  hubApi,
  setAuthToken,
  subscribeHubEvents
} from './api/client';
import type {
  AgentKind,
  HandoffJobRecord,
  NodeInfo,
  ProgressSnapshot,
  SessionRecord
} from './api/types';
import { BulkHandoffModal } from './components/BulkHandoffModal';
import { NewSessionModal } from './components/NewSessionModal';
import { ProgressPanel } from './components/ProgressPanel';
import { SessionSidebar } from './components/SessionSidebar';
import { TerminalPane } from './components/TerminalPane';
import { TopBar } from './components/TopBar';

export function App() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffJobRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedSessionId;

  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [nodeFilter, setNodeFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<AgentKind | 'all'>('all');
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  const loadInitial = async () => {
    try {
      const [n, s, h] = await Promise.all([
        hubApi.getNodes(),
        hubApi.getSessions(),
        hubApi.getHandoffs()
      ]);
      setNodes(n);
      setSessions(s);
      setHandoffs(h);
      if (!selectedRef.current && s.length > 0) {
        setSelectedSessionId(s[0].id);
      }
    } catch {
      // ignore initial auth/offline error until token set or hub ready
    }
  };

  useEffect(() => {
    void loadInitial();
    const unsubscribe = subscribeHubEvents(
      (evt) => {
        if (evt.type === 'snapshot') {
          setNodes(evt.nodes);
          setSessions(evt.sessions);
          setHandoffs(evt.handoffs);
          if (!selectedRef.current && evt.sessions.length > 0) {
            setSelectedSessionId(evt.sessions[0].id);
          }
        } else if (evt.type === 'node_update') {
          setNodes((prev) => {
            const exists = prev.some((n) => n.id === evt.node.id);
            return exists
              ? prev.map((n) => (n.id === evt.node.id ? evt.node : n))
              : [...prev, evt.node];
          });
        } else if (evt.type === 'session_update') {
          setSessions((prev) => {
            const exists = prev.some((s) => s.id === evt.session.id);
            const next = exists
              ? prev.map((s) => (s.id === evt.session.id ? evt.session : s))
              : [evt.session, ...prev];
            return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          });
        } else if (evt.type === 'handoff_update') {
          setHandoffs((prev) => {
            const exists = prev.some((j) => j.id === evt.job.id);
            const next = exists
              ? prev.map((j) => (j.id === evt.job.id ? evt.job : j))
              : [evt.job, ...prev];
            return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          });
          if (
            evt.job.status === 'SUCCEEDED' &&
            evt.job.targetSessionId &&
            selectedRef.current === evt.job.sourceSessionId
          ) {
            setSelectedSessionId(evt.job.targetSessionId);
          }
        } else if (evt.type === 'approval_alert') {
          if (
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted'
          ) {
            new Notification(`Agent Hub 待审批 (${evt.session.agent})`, {
              body: evt.prompt
            });
          }
        }
      },
      (connected) => setWsConnected(connected)
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const fetchProgress = async () => {
      try {
        const snap = await hubApi.getProgress(selectedSessionId);
        if (!cancelled) setProgress(snap);
      } catch {
        // ignore if session purged or offline
      }
    };
    void fetchProgress();
    const timer = window.setInterval(() => void fetchProgress(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const companionNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.role === 'companion').map((n) => n.id)),
    [nodes]
  );

  const activeMacSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          companionNodeIds.has(s.nodeId) &&
          (s.state === 'RUNNING' ||
            s.state === 'WAITING_APPROVAL' ||
            s.state === 'IDLE')
      ),
    [sessions, companionNodeIds]
  );

  const relatedHandoff = useMemo(() => {
    if (!selectedSession) return null;
    return (
      handoffs.find(
        (j) =>
          j.sourceSessionId === selectedSession.id ||
          j.targetSessionId === selectedSession.id
      ) ?? null
    );
  }, [handoffs, selectedSession]);

  const handleToggleNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    if (!notificationsEnabled) {
      const perm = await Notification.requestPermission();
      setNotificationsEnabled(perm === 'granted');
    } else {
      setNotificationsEnabled(false);
    }
  };

  const handleConfigureToken = () => {
    const next = window.prompt(
      '输入 Agent Hub 共享认证 Token（若未配置服务端 Token 可留空）：',
      getAuthToken()
    );
    if (next !== null) {
      setAuthToken(next);
      window.location.reload();
    }
  };

  const handleHandoffSession = async (sessionId: string) => {
    try {
      await hubApi.startHandoff(sessionId);
      setSelectedSessionId(sessionId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStopSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    const shouldPurge =
      session?.state === 'EXITED' || session?.state === 'HANDED_OFF';
    try {
      await hubApi.stopSession(sessionId, shouldPurge);
      if (shouldPurge) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (selectedSessionId === sessionId) setSelectedSessionId(null);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRetryHandoff = async (jobId: string) => {
    try {
      await hubApi.retryHandoff(jobId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app-shell">
      <TopBar
        nodes={nodes}
        wsConnected={wsConnected}
        activeMacCount={activeMacSessions.length}
        notificationsEnabled={notificationsEnabled}
        onToggleNotifications={() => void handleToggleNotifications()}
        onConfigureToken={handleConfigureToken}
        onOpenNewSession={() => setNewModalOpen(true)}
        onOpenBulkHandoff={() => setBulkModalOpen(true)}
      />

      <main className="workspace-grid">
        <SessionSidebar
          nodes={nodes}
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          nodeFilter={nodeFilter}
          agentFilter={agentFilter}
          onNodeFilterChange={setNodeFilter}
          onAgentFilterChange={setAgentFilter}
          onSelectSession={setSelectedSessionId}
          onHandoffSession={(id) => void handleHandoffSession(id)}
          onStopSession={(id) => void handleStopSession(id)}
        />

        <TerminalPane
          session={selectedSession}
          onHandoffSession={(id) => void handleHandoffSession(id)}
          onSwitchToSession={setSelectedSessionId}
        />

        <ProgressPanel
          session={selectedSession}
          progress={progress}
          relatedHandoff={relatedHandoff}
          onRetryHandoff={(jobId) => void handleRetryHandoff(jobId)}
        />
      </main>

      <NewSessionModal
        open={newModalOpen}
        nodes={nodes}
        onClose={() => setNewModalOpen(false)}
        onCreated={(created) => {
          setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
          setSelectedSessionId(created.id);
        }}
      />

      <BulkHandoffModal
        open={bulkModalOpen}
        macSessions={activeMacSessions}
        handoffs={handoffs}
        onClose={() => setBulkModalOpen(false)}
      />
    </div>
  );
}
export default App;
