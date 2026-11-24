import WebSocket from 'ws';
import {
  AgentHubError,
  type AgentKind,
  type DiscoveredSession,
  type ExportBundleResponse,
  type FreezeResult,
  type GitWipResult,
  type ImportBundleRequest,
  type ImportBundleResult,
  type NodeInfo,
  type ProgressSnapshot,
  type RepoInfo,
  type ResumeSessionRequest,
  type SessionRecord,
  type StartSessionRequest,
  type TargetWorkspacePrepResult
} from '@agent-hub/protocol';
import type { NodeProvider, TargetWorkspacePrepInput } from './node-provider.js';

export class HttpNodeProvider implements NodeProvider {
  public readonly nodeId: string;
  public readonly role = 'companion' as const;

  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(opts: { nodeId: string; baseUrl: string; authToken?: string }) {
    this.nodeId = opts.nodeId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authToken = opts.authToken ?? '';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.authToken) {
      h.Authorization = `Bearer ${this.authToken}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    timeoutMs = 10000
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new AgentHubError(
        'NODE_OFFLINE',
        `Remote node ${this.nodeId} unreachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        503
      );
    }

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
          ? (parsed as { code?: string; message?: string; details?: unknown })
          : {};
      throw new AgentHubError(
        (errObj.code as AgentHubError['code']) || 'INTERNAL_ERROR',
        errObj.message || `Companion HTTP ${res.status}`,
        res.status,
        errObj.details
      );
    }

    return parsed as T;
  }

  async probe(): Promise<NodeInfo> {
    return this.request<NodeInfo>('GET', '/probe', undefined, 4000);
  }

  async listWorkspaces(): Promise<RepoInfo[]> {
    return this.request<RepoInfo[]>('GET', '/workspaces', undefined, 5000);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.request<SessionRecord[]>('GET', '/sessions', undefined, 5000);
  }

  async discoverSessions(agent?: AgentKind, limit = 50): Promise<DiscoveredSession[]> {
    const params = new URLSearchParams();
    if (agent) params.set('agent', agent);
    params.set('limit', String(limit));
    return this.request<DiscoveredSession[]>(
      'GET',
      `/sessions/discovered?${params.toString()}`,
      undefined,
      8000
    );
  }

  async getProgress(sessionId: string): Promise<ProgressSnapshot> {
    return this.request<ProgressSnapshot>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/progress`,
      undefined,
      6000
    );
  }

  async startSession(req: StartSessionRequest): Promise<SessionRecord> {
    return this.request<SessionRecord>('POST', '/sessions/start', req, 15000);
  }

  async resumeSession(req: ResumeSessionRequest): Promise<SessionRecord> {
    return this.request<SessionRecord>('POST', '/sessions/resume', req, 15000);
  }

  async stopSession(sessionId: string, purge = false): Promise<void> {
    await this.request(
      'DELETE',
      `/sessions/${encodeURIComponent(sessionId)}${purge ? '?purge=1' : ''}`,
      undefined,
      8000
    );
  }

  attachPty(
    sessionId: string,
    clientSocket: WebSocket,
    cols: number,
    rows: number
  ): void {
    const wsBase = this.baseUrl
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://');
    const url = `${wsBase}/ws/sessions/${encodeURIComponent(sessionId)}/pty?cols=${cols}&rows=${rows}`;

    const upstream = new WebSocket(url, {
      headers: this.authToken
        ? { Authorization: `Bearer ${this.authToken}` }
        : undefined
    });

    const pendingClientMessages: string[] = [];

    upstream.on('open', () => {
      while (pendingClientMessages.length > 0) {
        const msg = pendingClientMessages.shift();
        if (msg) upstream.send(msg);
      }
    });

    upstream.on('message', (data) => {
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.send(data.toString());
      }
    });

    upstream.on('close', () => {
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.close();
      }
    });

    upstream.on('error', (err) => {
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.send(
          JSON.stringify({
            type: 'status',
            state: 'ERROR',
            message: err.message
          })
        );
        clientSocket.close();
      }
    });

    clientSocket.on('message', (data) => {
      const text = data.toString();
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pendingClientMessages.push(text);
      }
    });

    clientSocket.on('close', () => {
      if (
        upstream.readyState === WebSocket.OPEN ||
        upstream.readyState === WebSocket.CONNECTING
      ) {
        upstream.close();
      }
    });
  }

  async freezeSession(sessionId: string): Promise<FreezeResult> {
    return this.request<FreezeResult>(
      'POST',
      '/handoff/freeze',
      { sessionId },
      20000
    );
  }

  async createGitWip(
    sessionId: string,
    skipGitPush = false
  ): Promise<GitWipResult & { subPath: string }> {
    return this.request<GitWipResult & { subPath: string }>(
      'POST',
      '/handoff/git-wip',
      { sessionId, skipGitPush },
      180000
    );
  }

  async exportBundle(sessionId: string): Promise<ExportBundleResponse> {
    return this.request<ExportBundleResponse>(
      'POST',
      '/handoff/export',
      { sessionId },
      60000
    );
  }

  async markHandedOff(
    sessionId: string,
    targetSessionId: string
  ): Promise<SessionRecord> {
    return this.request<SessionRecord>(
      'POST',
      '/handoff/mark-handed-off',
      { sessionId, targetSessionId },
      8000
    );
  }

  async rollbackHandoff(sessionId: string): Promise<SessionRecord> {
    return this.request<SessionRecord>(
      'POST',
      '/handoff/rollback',
      { sessionId },
      8000
    );
  }

  async prepareTargetWorkspace(
    _input: TargetWorkspacePrepInput
  ): Promise<TargetWorkspacePrepResult> {
    throw new AgentHubError(
      'INVALID_REQUEST',
      'Companion node does not accept incoming handoffs in v1',
      400
    );
  }

  async importBundle(_req: ImportBundleRequest): Promise<ImportBundleResult> {
    throw new AgentHubError(
      'INVALID_REQUEST',
      'Companion node does not accept incoming handoffs in v1',
      400
    );
  }

  async hasLiveSession(_tmuxName: string): Promise<boolean> {
    return false;
  }

  async sendContinuationText(_tmuxName: string, _text: string): Promise<void> {
    throw new AgentHubError(
      'INVALID_REQUEST',
      'sendContinuationText not supported directly on remote provider',
      400
    );
  }
}
