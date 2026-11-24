import type {
  AgentKind,
  DiscoveredSession,
  HandoffJobRecord,
  HubEventMessage,
  NodeInfo,
  ProgressSnapshot,
  RepoInfo,
  ResumeSessionPayload,
  SessionRecord,
  StartSessionPayload
} from './types';

const TOKEN_STORAGE_KEY = 'agent_hub_auth_token';

export function getAuthToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

export function setAuthToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string>) || {})
  };
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const errObj =
      parsed && typeof parsed === 'object'
        ? (parsed as { message?: string; code?: string })
        : {};
    throw new Error(errObj.message || `HTTP ${res.status}`);
  }
  return parsed as T;
}

export const hubApi = {
  getNodes: () => apiFetch<NodeInfo[]>('/api/nodes'),
  getWorkspaces: (nodeId: string) =>
    apiFetch<RepoInfo[]>(`/api/workspaces?nodeId=${encodeURIComponent(nodeId)}`),
  getSessions: () => apiFetch<SessionRecord[]>('/api/sessions'),
  discoverSessions: (nodeId: string, agent: AgentKind) =>
    apiFetch<DiscoveredSession[]>(
      `/api/sessions/discovered?nodeId=${encodeURIComponent(nodeId)}&agent=${encodeURIComponent(agent)}`
    ),
  getProgress: (sessionId: string) =>
    apiFetch<ProgressSnapshot>(
      `/api/sessions/${encodeURIComponent(sessionId)}/progress`
    ),
  startSession: (payload: StartSessionPayload) =>
    apiFetch<SessionRecord>('/api/sessions/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  resumeSession: (payload: ResumeSessionPayload) =>
    apiFetch<SessionRecord>('/api/sessions/resume', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  stopSession: (sessionId: string, purge = false) =>
    apiFetch<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}${purge ? '?purge=1' : ''}`,
      { method: 'DELETE' }
    ),
  getHandoffs: () => apiFetch<HandoffJobRecord[]>('/api/handoffs'),
  startHandoff: (sessionId: string, opts?: { forceWorktree?: boolean }) =>
    apiFetch<HandoffJobRecord>('/api/handoffs', {
      method: 'POST',
      body: JSON.stringify({ sessionId, ...opts })
    }),
  startBatchHandoff: (sessionIds?: string[]) =>
    apiFetch<{ batchId: string; jobs: HandoffJobRecord[] }>(
      '/api/handoffs/batch',
      {
        method: 'POST',
        body: JSON.stringify(sessionIds ? { sessionIds } : {})
      }
    ),
  retryHandoff: (jobId: string) =>
    apiFetch<HandoffJobRecord>(`/api/handoffs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST'
    })
};

export function buildWsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getAuthToken();
  const sep = path.includes('?') ? '&' : '?';
  const suffix = token ? `${sep}token=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}${path}${suffix}`;
}

export function subscribeHubEvents(
  onMessage: (evt: HubEventMessage) => void,
  onConnectionChange: (connected: boolean) => void
): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let timer: number | null = null;

  const connect = (): void => {
    if (disposed) return;
    ws = new WebSocket(buildWsUrl('/ws/events'));
    ws.onopen = () => {
      onConnectionChange(true);
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as HubEventMessage;
        onMessage(msg);
      } catch {
        // ignore malformed event
      }
    };
    ws.onclose = () => {
      onConnectionChange(false);
      if (!disposed) {
        timer = window.setTimeout(connect, 1800);
      }
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  connect();
  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    ws?.close();
  };
}
