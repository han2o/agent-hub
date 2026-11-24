import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDefaultRegistry } from '@agent-hub/adapters';
import {
  AgentHubError,
  AgentKindSchema,
  isAgentHubError,
  PtyClientMessageSchema,
  RegisterWrappedSessionRequestSchema,
  ResumeSessionRequestSchema,
  StartSessionRequestSchema,
  type AppConfig,
  type DiscoveredSession,
  type ExportBundleResponse,
  type FreezeResult,
  type NodeInfo,
  type ProgressSnapshot,
  type SessionRecord
} from '@agent-hub/protocol';
import {
  GitWorkspaceEngine,
  packDirectoryToBuffer,
  PtySessionStream,
  reconcileTmuxSessions,
  SessionObserver,
  TmuxManager
} from '@agent-hub/runtime';
import { CompanionStore } from './store.js';

export interface CompanionServerContext {
  app: FastifyInstance;
  store: CompanionStore;
  tmux: TmuxManager;
  git: GitWorkspaceEngine;
  close(): Promise<void>;
}

export async function createCompanionServer(
  config: AppConfig
): Promise<CompanionServerContext> {
  const dbPath = path.join(config.dataDir, 'companion.db');
  const store = new CompanionStore(dbPath);
  const registry = createDefaultRegistry({
    homeDir: config.homeDir,
    dataDir: config.dataDir,
    agents: config.agents
  });
  const tmux = new TmuxManager({ socketName: config.tmuxSocket });
  const git = new GitWorkspaceEngine();
  const observer = new SessionObserver(registry, tmux);

  await reconcileTmuxSessions(store.listSessions(), tmux, (sessionId) => {
    const existing = store.getSession(sessionId);
    if (existing) {
      store.upsertSession({
        ...existing,
        state: 'EXITED',
        updatedAt: new Date().toISOString()
      });
    }
  });

  const app = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Auth middleware (skip /health)
  app.addHook('onRequest', async (req, reply) => {
    if (!config.authToken) return;
    if (req.url.startsWith('/health')) return;
    const authHeader = req.headers.authorization;
    const queryToken =
      typeof (req.query as Record<string, unknown>)?.token === 'string'
        ? String((req.query as Record<string, unknown>).token)
        : '';
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : '';
    if (bearer !== config.authToken && queryToken !== config.authToken) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (isAgentHubError(err)) {
      return reply.code(err.statusCode).send(err.toJSON());
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message });
  });

  const refreshSession = async (session: SessionRecord): Promise<SessionRecord> => {
    let current = session;
    if (
      !current.externalSessionId &&
      current.state !== 'HANDED_OFF' &&
      current.state !== 'EXITED'
    ) {
      const adapter = registry.get(current.agent);
      const sinceMs = new Date(current.createdAt).getTime() - 2000;
      const found = await adapter.findLatestSessionForCwd(current.cwd, sinceMs);
      if (found) {
        current = {
          ...current,
          externalSessionId: found.externalSessionId,
          sessionFilePath: found.filePath,
          title:
            current.title === `${current.agent} @ ${path.basename(current.cwd)}` &&
            found.title
              ? found.title
              : current.title
        };
      }
    }

    const snap = await observer.observe(current);
    const updated: SessionRecord = {
      ...current,
      state: snap.state,
      latestSummary: snap.summary || current.latestSummary,
      approvalPrompt: snap.approvalPrompt,
      updatedAt: new Date().toISOString()
    };
    store.upsertSession(updated);
    return updated;
  };

  app.get('/health', async () => ({
    ok: true,
    role: 'companion',
    nodeId: config.nodeId,
    timestamp: new Date().toISOString()
  }));

  app.get('/probe', async (): Promise<NodeInfo> => {
    const agents = await Promise.all(registry.list().map((a) => a.probe()));
    const repos = await git.listReposInRoots(config.workspaceRoots, 3);
    return {
      id: config.nodeId,
      name: config.nodeName,
      role: 'companion',
      os: `${os.platform()}/${os.arch()}`,
      homeDir: config.homeDir,
      workspaceRoots: config.workspaceRoots,
      worktreesRoot: config.worktreesRoot,
      status: 'ONLINE',
      lastSeenAt: new Date().toISOString(),
      agents,
      repos
    };
  });

  app.get('/workspaces', async () => {
    return git.listReposInRoots(config.workspaceRoots, 3);
  });

  app.get('/sessions', async () => {
    const list = store.listSessions();
    const out: SessionRecord[] = [];
    for (const s of list) {
      if (
        s.state === 'RUNNING' ||
        s.state === 'WAITING_APPROVAL' ||
        s.state === 'IDLE'
      ) {
        out.push(await refreshSession(s));
      } else {
        out.push(s);
      }
    }
    return out;
  });

  app.get('/sessions/discovered', async (req) => {
    const q = req.query as { agent?: string; limit?: string };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 50;
    if (q.agent) {
      const kind = AgentKindSchema.parse(q.agent);
      return registry.get(kind).discoverSessions(limit);
    }
    const all: DiscoveredSession[] = [];
    for (const adapter of registry.list()) {
      all.push(...(await adapter.discoverSessions(limit)));
    }
    return all
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  });

  app.get('/sessions/:id/progress', async (req): Promise<ProgressSnapshot> => {
    const { id } = req.params as { id: string };
    const existing = store.getSession(id);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${id}`, 404);
    }
    const updated = await refreshSession(existing);
    return observer.observe(updated);
  });

  app.post('/sessions/start', async (req): Promise<SessionRecord> => {
    const parsed = StartSessionRequestSchema.parse(req.body);
    if (!fs.existsSync(parsed.cwd)) {
      throw new AgentHubError(
        'INVALID_REQUEST',
        `Working directory does not exist: ${parsed.cwd}`,
        400
      );
    }

    const id = crypto.randomUUID();
    const tmuxName = `ah-${parsed.agent}-${id.slice(0, 8)}`;
    const adapter = registry.get(parsed.agent);
    const inv = adapter.buildStartCommand(parsed);
    const repo = await git.inspectRepo(parsed.cwd);
    const pid = await tmux.createSession({
      name: tmuxName,
      cwd: parsed.cwd,
      shellCommand: inv.shellCommand
    });

    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      nodeId: config.nodeId,
      agent: parsed.agent,
      externalSessionId: null,
      sessionFilePath: null,
      title: parsed.title || `${parsed.agent} @ ${path.basename(parsed.cwd)}`,
      cwd: parsed.cwd,
      gitOrigin: repo.originUrl,
      gitBranch: repo.branch,
      tmuxName,
      pid,
      permissionMode: parsed.permissionMode ?? 'default',
      cliArgs: parsed.extraArgs ?? [],
      model: parsed.model ?? null,
      state: parsed.initialPrompt ? 'RUNNING' : 'IDLE',
      sourceType: 'web',
      latestSummary: parsed.initialPrompt || 'Started via Agent Hub',
      approvalPrompt: null,
      handedOffToSessionId: null,
      handedOffFromSessionId: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now
    };
    store.upsertSession(record);
    return record;
  });

  app.post('/sessions/resume', async (req): Promise<SessionRecord> => {
    const parsed = ResumeSessionRequestSchema.parse(req.body);
    if (!fs.existsSync(parsed.cwd)) {
      throw new AgentHubError(
        'INVALID_REQUEST',
        `Working directory does not exist: ${parsed.cwd}`,
        400
      );
    }

    const id = crypto.randomUUID();
    const tmuxName = `ah-${parsed.agent}-${id.slice(0, 8)}`;
    const adapter = registry.get(parsed.agent);
    const inv = adapter.buildResumeCommand(parsed);
    const repo = await git.inspectRepo(parsed.cwd);
    const pid = await tmux.createSession({
      name: tmuxName,
      cwd: parsed.cwd,
      shellCommand: inv.shellCommand
    });

    if (parsed.continuationPrompt) {
      setTimeout(() => {
        void tmux.sendText(tmuxName, parsed.continuationPrompt!).catch(() => {});
      }, 1500);
    }

    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      nodeId: config.nodeId,
      agent: parsed.agent,
      externalSessionId: parsed.externalSessionId,
      sessionFilePath: parsed.sessionFilePath ?? null,
      title: parsed.title || `${parsed.agent} @ ${path.basename(parsed.cwd)}`,
      cwd: parsed.cwd,
      gitOrigin: repo.originUrl,
      gitBranch: repo.branch,
      tmuxName,
      pid,
      permissionMode: parsed.permissionMode ?? 'default',
      cliArgs: parsed.extraArgs ?? [],
      model: parsed.model ?? null,
      state: parsed.continuationPrompt ? 'RUNNING' : 'IDLE',
      sourceType: 'web',
      latestSummary: parsed.continuationPrompt || 'Resumed session',
      approvalPrompt: null,
      handedOffToSessionId: null,
      handedOffFromSessionId: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now
    };
    store.upsertSession(record);
    return record;
  });

  app.post('/sessions/register-wrapped', async (req): Promise<SessionRecord> => {
    const parsed = RegisterWrappedSessionRequestSchema.parse(req.body);
    const id = parsed.id || crypto.randomUUID();
    const repo = await git.inspectRepo(parsed.cwd);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      nodeId: config.nodeId,
      agent: parsed.agent,
      externalSessionId: parsed.externalSessionId ?? null,
      sessionFilePath: null,
      title: parsed.title || `${parsed.agent} @ ${path.basename(parsed.cwd)}`,
      cwd: parsed.cwd,
      gitOrigin: repo.originUrl,
      gitBranch: repo.branch,
      tmuxName: parsed.tmuxName,
      pid: parsed.pid ?? null,
      permissionMode: parsed.permissionMode ?? 'default',
      cliArgs: parsed.cliArgs ?? [],
      model: parsed.model ?? null,
      state: 'RUNNING',
      sourceType: 'wrapped',
      latestSummary: 'Started via local CLI wrapper',
      approvalPrompt: null,
      handedOffToSessionId: null,
      handedOffFromSessionId: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now
    };
    store.upsertSession(record);
    return record;
  });

  app.delete('/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { purge?: string };
    const existing = store.getSession(id);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${id}`, 404);
    }
    if (existing.tmuxName) {
      await tmux.killSession(existing.tmuxName);
    }
    if (q.purge === '1') {
      store.deleteSession(id);
    } else {
      store.upsertSession({
        ...existing,
        state: 'EXITED',
        updatedAt: new Date().toISOString()
      });
    }
    return { ok: true };
  });

  app.get('/ws/sessions/:id/pty', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const session = store.getSession(id);
    if (!session || !session.tmuxName) {
      socket.send(
        JSON.stringify({
          type: 'status',
          state: 'ERROR',
          message: 'Session not found'
        })
      );
      socket.close();
      return;
    }

    const q = req.query as { cols?: string; rows?: string };
    const cols = q.cols ? Number(q.cols) : 120;
    const rows = q.rows ? Number(q.rows) : 36;

    let stream: PtySessionStream;
    try {
      stream = new PtySessionStream({
        command: tmux.attachCommand(session.tmuxName),
        cwd: session.cwd,
        cols,
        rows
      });
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: 'status',
          state: 'ERROR',
          message: err instanceof Error ? err.message : String(err)
        })
      );
      socket.close();
      return;
    }

    stream.on('data', (chunk: Buffer) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
      }
    });

    stream.on('exit', (code: number | null) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', code }));
        socket.close();
      }
    });

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = PtyClientMessageSchema.parse(JSON.parse(raw.toString()));
        if (msg.type === 'input') {
          stream.write(msg.data);
        } else if (msg.type === 'resize') {
          stream.resize(msg.cols, msg.rows);
        }
      } catch {
        // ignore invalid WS payload
      }
    });

    socket.on('close', () => {
      stream.detach();
    });
  });

  // ---- Handoff source endpoints ----

  app.post('/handoff/freeze', async (req): Promise<FreezeResult> => {
    const { sessionId } = req.body as { sessionId: string };
    const existing = store.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }

    const refreshed = await refreshSession(existing);
    const previousState = refreshed.state;
    const stdoutTail = refreshed.tmuxName
      ? await tmux.capturePane(refreshed.tmuxName, 40)
      : '';

    store.upsertSession({
      ...refreshed,
      state: 'HANDING_OFF',
      updatedAt: new Date().toISOString()
    });

    if (refreshed.tmuxName && (await tmux.hasSession(refreshed.tmuxName))) {
      await tmux.gracefulStop(refreshed.tmuxName);
      await new Promise((r) => setTimeout(r, 250));
    }

    let externalSessionId = refreshed.externalSessionId;
    let sessionFilePath = refreshed.sessionFilePath;
    if (!externalSessionId) {
      const adapter = registry.get(refreshed.agent);
      const sinceMs = new Date(refreshed.createdAt).getTime() - 5000;
      const found = await adapter.findLatestSessionForCwd(refreshed.cwd, sinceMs);
      if (found) {
        externalSessionId = found.externalSessionId;
        sessionFilePath = found.filePath;
      }
    }

    const finalRecord: SessionRecord = {
      ...refreshed,
      externalSessionId,
      sessionFilePath,
      state: 'HANDING_OFF',
      updatedAt: new Date().toISOString()
    };
    store.upsertSession(finalRecord);

    return {
      sessionId: finalRecord.id,
      previousState,
      externalSessionId,
      sessionFilePath,
      cwd: finalRecord.cwd,
      title: finalRecord.title,
      permissionMode: finalRecord.permissionMode,
      cliArgs: finalRecord.cliArgs,
      model: finalRecord.model,
      agent: finalRecord.agent,
      stdoutTail
    };
  });

  app.post('/handoff/git-wip', async (req) => {
    const { sessionId, skipGitPush } = req.body as {
      sessionId: string;
      skipGitPush?: boolean;
    };
    const existing = store.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const res = await git.createAndPushWipBranch({
      cwd: existing.cwd,
      sessionId: existing.id,
      wipBranchPrefix: config.handoff.wipBranchPrefix,
      skipGitPush
    });
    if (res.isGit) {
      store.upsertSession({
        ...existing,
        gitOrigin: res.originUrl,
        gitBranch: res.wipBranch,
        updatedAt: new Date().toISOString()
      });
    }
    return res;
  });

  app.post('/handoff/export', async (req): Promise<ExportBundleResponse> => {
    const { sessionId } = req.body as { sessionId: string };
    const existing = store.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    if (!existing.externalSessionId) {
      throw new AgentHubError(
        'BUNDLE_EXPORT_FAILED',
        `Session ${sessionId} has no externalSessionId yet (agent may not have persisted a turn)`,
        400
      );
    }
    const adapter = registry.get(existing.agent);
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-export-'));
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
      return {
        manifest,
        archiveBase64: buf.toString('base64')
      };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  app.post('/handoff/mark-handed-off', async (req) => {
    const { sessionId, targetSessionId } = req.body as {
      sessionId: string;
      targetSessionId?: string;
    };
    const existing = store.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const updated: SessionRecord = {
      ...existing,
      state: 'HANDED_OFF',
      handedOffToSessionId: targetSessionId ?? existing.handedOffToSessionId,
      updatedAt: new Date().toISOString()
    };
    store.upsertSession(updated);
    return updated;
  });

  app.post('/handoff/rollback', async (req) => {
    const { sessionId } = req.body as { sessionId: string };
    const existing = store.getSession(sessionId);
    if (!existing) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const alive = existing.tmuxName ? await tmux.hasSession(existing.tmuxName) : false;
    const restored: SessionRecord = {
      ...existing,
      state: alive ? 'IDLE' : 'EXITED',
      updatedAt: new Date().toISOString()
    };
    store.upsertSession(restored);
    return restored;
  });

  return {
    app,
    store,
    tmux,
    git,
    async close() {
      await app.close();
      store.close();
    }
  };
}
