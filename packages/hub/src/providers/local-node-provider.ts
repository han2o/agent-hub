import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { createDefaultRegistry, type AdapterRegistry } from '@agent-hub/adapters';
import {
  AgentHubError,
  PtyClientMessageSchema,
  type AgentKind,
  type AppConfig,
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
import {
  GitWorkspaceEngine,
  packDirectoryToBuffer,
  PtySessionStream,
  SessionObserver,
  TmuxManager,
  unpackBufferToDirectory
} from '@agent-hub/runtime';
import type { HubDatabase } from '../db.js';
import type { NodeProvider, TargetWorkspacePrepInput } from './node-provider.js';

export class LocalNodeProvider implements NodeProvider {
  public readonly nodeId: string;
  public readonly role = 'hub' as const;

  public readonly registry: AdapterRegistry;
  public readonly tmux: TmuxManager;
  public readonly git: GitWorkspaceEngine;
  public readonly observer: SessionObserver;

  private readonly config: AppConfig;
  private readonly db: HubDatabase;

  constructor(config: AppConfig, db: HubDatabase) {
    this.config = config;
    this.db = db;
    this.nodeId = config.nodeId;
    this.registry = createDefaultRegistry({
      homeDir: config.homeDir,
      dataDir: config.dataDir,
      agents: config.agents
    });
    this.tmux = new TmuxManager({ socketName: config.tmuxSocket });
    this.git = new GitWorkspaceEngine();
    this.observer = new SessionObserver(this.registry, this.tmux);
  }

  async probe(): Promise<NodeInfo> {
    const agents = await Promise.all(this.registry.list().map((a) => a.probe()));
    const repos = await this.git.listReposInRoots(this.config.workspaceRoots, 3);
    const info: NodeInfo = {
      id: this.config.nodeId,
      name: this.config.nodeName,
      role: 'hub',
      os: `${os.platform()}/${os.arch()}`,
      homeDir: this.config.homeDir,
      workspaceRoots: this.config.workspaceRoots,
      worktreesRoot: this.config.worktreesRoot,
      status: 'ONLINE',
      lastSeenAt: new Date().toISOString(),
      agents,
      repos
    };
    this.db.upsertNode(info);
    return info;
  }

  async listWorkspaces(): Promise<RepoInfo[]> {
    return this.git.listReposInRoots(this.config.workspaceRoots, 3);
  }

  private async refreshSession(session: SessionRecord): Promise<SessionRecord> {
    let current = session;
    if (
      !current.externalSessionId &&
      current.state !== 'HANDED_OFF' &&
      current.state !== 'EXITED'
    ) {
      const adapter = this.registry.get(current.agent);
      const sinceMs = new Date(current.createdAt).getTime() - 2000;
      const found = await adapter.findLatestSessionForCwd(current.cwd, sinceMs);
      if (found) {
        current = {
          ...current,
          externalSessionId: found.externalSessionId,
          sessionFilePath: found.filePath
        };
      }
    }

    const snap = await this.observer.observe(current);
    const updated: SessionRecord = {
      ...current,
      state: snap.state,
      latestSummary: snap.summary || current.latestSummary,
      approvalPrompt: snap.approvalPrompt,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertSession(updated);
    return updated;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = this.db.listSessions({ nodeId: this.nodeId });
    const out: SessionRecord[] = [];
    for (const s of rows) {
      if (
        s.state === 'RUNNING' ||
        s.state === 'WAITING_APPROVAL' ||
        s.state === 'IDLE'
      ) {
        out.push(await this.refreshSession(s));
      } else {
        out.push(s);
      }
    }
    return out;
  }

  async discoverSessions(agent?: AgentKind, limit = 50): Promise<DiscoveredSession[]> {
    if (agent) {
      return this.registry.get(agent).discoverSessions(limit);
    }
    const all: DiscoveredSession[] = [];
    for (const adapter of this.registry.list()) {
      all.push(...(await adapter.discoverSessions(limit)));
    }
    return all
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async getProgress(sessionId: string): Promise<ProgressSnapshot> {
    const existing = this.db.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const updated = await this.refreshSession(existing);
    return this.observer.observe(updated);
  }

  async startSession(req: StartSessionRequest): Promise<SessionRecord> {
    if (!fs.existsSync(req.cwd)) {
      throw new AgentHubError(
        'INVALID_REQUEST',
        `Working directory does not exist: ${req.cwd}`,
        400
      );
    }
    const id = crypto.randomUUID();
    const tmuxName = `ah-${req.agent}-${id.slice(0, 8)}`;
    const adapter = this.registry.get(req.agent);
    const inv = adapter.buildStartCommand(req);
    const repo = await this.git.inspectRepo(req.cwd);
    const pid = await this.tmux.createSession({
      name: tmuxName,
      cwd: req.cwd,
      shellCommand: inv.shellCommand
    });

    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      nodeId: this.nodeId,
      agent: req.agent,
      externalSessionId: null,
      sessionFilePath: null,
      title: req.title || `${req.agent} @ ${path.basename(req.cwd)}`,
      cwd: req.cwd,
      gitOrigin: repo.originUrl,
      gitBranch: repo.branch,
      tmuxName,
      pid,
      permissionMode: req.permissionMode ?? 'default',
      cliArgs: req.extraArgs ?? [],
      model: req.model ?? null,
      state: req.initialPrompt ? 'RUNNING' : 'IDLE',
      sourceType: 'web',
      latestSummary: req.initialPrompt || 'Started on Mini',
      approvalPrompt: null,
      handedOffToSessionId: null,
      handedOffFromSessionId: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now
    };
    this.db.upsertSession(record);
    return record;
  }

  async resumeSession(
    req: ResumeSessionRequest,
    opts?: {
      sourceType?: SessionRecord['sourceType'];
      handedOffFromSessionId?: string | null;
      worktreePath?: string | null;
      useFallback?: boolean;
    }
  ): Promise<SessionRecord> {
    if (!fs.existsSync(req.cwd)) {
      throw new AgentHubError(
        'INVALID_REQUEST',
        `Working directory does not exist: ${req.cwd}`,
        400
      );
    }
    const id = crypto.randomUUID();
    const tmuxName = `ah-${req.agent}-${id.slice(0, 8)}`;
    const adapter = this.registry.get(req.agent);
    const inv =
      opts?.useFallback && adapter.buildFallbackResumeCommand
        ? adapter.buildFallbackResumeCommand(req) ?? adapter.buildResumeCommand(req)
        : adapter.buildResumeCommand(req);

    const repo = await this.git.inspectRepo(req.cwd);
    const pid = await this.tmux.createSession({
      name: tmuxName,
      cwd: req.cwd,
      shellCommand: inv.shellCommand
    });

    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      nodeId: this.nodeId,
      agent: req.agent,
      externalSessionId: opts?.useFallback ? null : req.externalSessionId,
      sessionFilePath: opts?.useFallback ? null : req.sessionFilePath ?? null,
      title: req.title || `${req.agent} @ ${path.basename(req.cwd)}`,
      cwd: req.cwd,
      gitOrigin: repo.originUrl,
      gitBranch: repo.branch,
      tmuxName,
      pid,
      permissionMode: req.permissionMode ?? 'default',
      cliArgs: req.extraArgs ?? [],
      model: req.model ?? null,
      state: req.continuationPrompt ? 'RUNNING' : 'IDLE',
      sourceType: opts?.sourceType ?? 'web',
      latestSummary: req.continuationPrompt || 'Resumed on Mini',
      approvalPrompt: null,
      handedOffToSessionId: null,
      handedOffFromSessionId: opts?.handedOffFromSessionId ?? null,
      worktreePath: opts?.worktreePath ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.db.upsertSession(record);
    return record;
  }

  async stopSession(sessionId: string, purge = false): Promise<void> {
    const existing = this.db.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    if (existing.tmuxName) {
      await this.tmux.killSession(existing.tmuxName);
    }
    if (purge) {
      this.db.deleteSession(sessionId);
    } else {
      this.db.upsertSession({
        ...existing,
        state: 'EXITED',
        updatedAt: new Date().toISOString()
      });
    }
  }

  attachPty(
    sessionId: string,
    clientSocket: WebSocket,
    cols: number,
    rows: number
  ): void {
    const session = this.db.getSession(sessionId);
    if (!session || !session.tmuxName) {
      clientSocket.send(
        JSON.stringify({
          type: 'status',
          state: 'ERROR',
          message: 'Session not found'
        })
      );
      clientSocket.close();
      return;
    }

    const stream = new PtySessionStream({
      command: this.tmux.attachCommand(session.tmuxName),
      cwd: session.cwd,
      cols,
      rows
    });

    stream.on('data', (chunk: Buffer) => {
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.send(
          JSON.stringify({ type: 'output', data: chunk.toString('utf8') })
        );
      }
    });

    stream.on('exit', (code: number | null) => {
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: 'exit', code }));
        clientSocket.close();
      }
    });

    clientSocket.on('message', (raw: Buffer | string) => {
      try {
        const msg = PtyClientMessageSchema.parse(JSON.parse(raw.toString()));
        if (msg.type === 'input') stream.write(msg.data);
        else if (msg.type === 'resize') stream.resize(msg.cols, msg.rows);
      } catch {
        // ignore invalid payload
      }
    });

    clientSocket.on('close', () => {
      stream.detach();
    });
  }

  async freezeSession(sessionId: string): Promise<FreezeResult> {
    const existing = this.db.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const refreshed = await this.refreshSession(existing);
    const previousState = refreshed.state;
    const stdoutTail = refreshed.tmuxName
      ? await this.tmux.capturePane(refreshed.tmuxName, 40)
      : '';
    this.db.upsertSession({
      ...refreshed,
      state: 'HANDING_OFF',
      updatedAt: new Date().toISOString()
    });
    if (refreshed.tmuxName && (await this.tmux.hasSession(refreshed.tmuxName))) {
      await this.tmux.gracefulStop(refreshed.tmuxName);
    }
    return {
      sessionId: refreshed.id,
      previousState,
      externalSessionId: refreshed.externalSessionId,
      sessionFilePath: refreshed.sessionFilePath,
      cwd: refreshed.cwd,
      title: refreshed.title,
      permissionMode: refreshed.permissionMode,
      cliArgs: refreshed.cliArgs,
      model: refreshed.model,
      agent: refreshed.agent,
      stdoutTail
    };
  }

  async createGitWip(
    sessionId: string,
    skipGitPush = false
  ): Promise<GitWipResult & { subPath: string }> {
    const existing = this.db.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    return this.git.createAndPushWipBranch({
      cwd: existing.cwd,
      sessionId: existing.id,
      wipBranchPrefix: this.config.handoff.wipBranchPrefix,
      skipGitPush
    });
  }

  async exportBundle(sessionId: string): Promise<ExportBundleResponse> {
    const existing = this.db.getSession(sessionId);
    if (!existing || !existing.externalSessionId) {
      throw new AgentHubError(
        'BUNDLE_EXPORT_FAILED',
        `Session ${sessionId} missing or lacks externalSessionId`,
        400
      );
    }
    const adapter = this.registry.get(existing.agent);
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-hub-export-'));
    try {
      const manifest = await adapter.exportBundle(
        {
          externalSessionId: existing.externalSessionId,
          sessionFilePath: existing.sessionFilePath,
          cwd: existing.cwd,
          title: existing.title
        },
        stagingDir
      );
      const buf = await packDirectoryToBuffer(stagingDir);
      return { manifest, archiveBase64: buf.toString('base64') };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  async markHandedOff(sessionId: string, targetSessionId: string): Promise<SessionRecord> {
    const existing = this.db.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const updated: SessionRecord = {
      ...existing,
      state: 'HANDED_OFF',
      handedOffToSessionId: targetSessionId,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertSession(updated);
    return updated;
  }

  async rollbackHandoff(sessionId: string): Promise<SessionRecord> {
    const existing = this.db.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const alive = existing.tmuxName
      ? await this.tmux.hasSession(existing.tmuxName)
      : false;
    const updated: SessionRecord = {
      ...existing,
      state: alive ? 'IDLE' : 'EXITED',
      updatedAt: new Date().toISOString()
    };
    this.db.upsertSession(updated);
    return updated;
  }

  async prepareTargetWorkspace(
    input: TargetWorkspacePrepInput
  ): Promise<TargetWorkspacePrepResult> {
    return this.git.prepareTargetWorkspace({
      ...input,
      targetHome: this.config.homeDir,
      targetWorkspaceRoots: this.config.workspaceRoots,
      worktreesRoot: this.config.worktreesRoot
    });
  }

  async importBundle(req: ImportBundleRequest): Promise<ImportBundleResult> {
    const adapter = this.registry.get(req.manifest.agent);
    const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-hub-import-'));
    try {
      const buf = Buffer.from(req.archiveBase64, 'base64');
      await unpackBufferToDirectory(buf, extractedDir);
      return await adapter.importBundle(req.manifest, extractedDir, req.pathMapping);
    } finally {
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }
  }

  async hasLiveSession(tmuxName: string): Promise<boolean> {
    return this.tmux.hasSession(tmuxName);
  }

  async sendContinuationText(tmuxName: string, text: string): Promise<void> {
    await this.tmux.sendText(tmuxName, text);
  }
}
