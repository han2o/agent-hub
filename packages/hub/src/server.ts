import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  AgentHubError,
  AgentKindSchema,
  BatchHandoffRequestSchema,
  HandoffRequestSchema,
  isAgentHubError,
  ResumeSessionRequestSchema,
  StartSessionRequestSchema,
  type AppConfig,
  type HubEventMessage,
  type NodeInfo,
  type SessionRecord
} from '@agent-hub/protocol';
import { reconcileTmuxSessions } from '@agent-hub/runtime';
import { HubDatabase } from './db.js';
import { HandoffSagaOrchestrator, type SagaOptions } from './handoff-saga.js';
import { HttpNodeProvider } from './providers/http-node-provider.js';
import { LocalNodeProvider } from './providers/local-node-provider.js';
import type { NodeProvider } from './providers/node-provider.js';

export interface HubServerOptions {
  webDistDir?: string;
  pollIntervalMs?: number;
  sagaOptions?: SagaOptions;
}

export interface HubServerContext {
  app: FastifyInstance;
  db: HubDatabase;
  localProvider: LocalNodeProvider;
  companionProvider: HttpNodeProvider;
  saga: HandoffSagaOrchestrator;
  pollOnce(): Promise<void>;
  close(): Promise<void>;
}

function resolveWebDistDir(override?: string): string | null {
  if (override && fs.existsSync(override)) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../../../packages/web/dist')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export async function createHubServer(
  config: AppConfig,
  opts: HubServerOptions = {}
): Promise<HubServerContext> {
  const dbPath = path.join(config.dataDir, 'hub.db');
  const db = new HubDatabase(dbPath);
  const localProvider = new LocalNodeProvider(config, db);
  const companionProvider = new HttpNodeProvider({
    nodeId: config.companionNodeId,
    baseUrl: config.companionUrl,
    authToken: config.authToken
  });

  const providers = new Map<string, NodeProvider>([
    [localProvider.nodeId, localProvider],
    [companionProvider.nodeId, companionProvider]
  ]);

  const getProvider = (nodeId: string): NodeProvider => {
    const p = providers.get(nodeId);
    if (!p) {
      throw new AgentHubError('NOT_FOUND', `Unknown node: ${nodeId}`, 404);
    }
    return p;
  };

  // Seed initial companion node entry so UI sees both nodes immediately
  if (!db.getNode(config.companionNodeId)) {
    db.upsertNode({
      id: config.companionNodeId,
      name: config.companionNodeName,
      role: 'companion',
      os: `${os.platform()}/${os.arch()}`,
      homeDir: config.homeDir,
      workspaceRoots: [],
      worktreesRoot: '',
      status: 'OFFLINE',
      lastSeenAt: new Date(0).toISOString(),
      agents: [],
      repos: []
    });
  }

  await reconcileTmuxSessions(
    db.listSessions({ nodeId: localProvider.nodeId }),
    localProvider.tmux,
    (sessionId) => {
      const s = db.getSession(sessionId);
      if (s) {
        db.upsertSession({
          ...s,
          state: 'EXITED',
          updatedAt: new Date().toISOString()
        });
      }
    }
  );

  const wsClients = new Set<WebSocket>();
  const emitEvent = (msg: HubEventMessage): void => {
    const payload = JSON.stringify(msg);
    for (const client of wsClients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  };

  const saga = new HandoffSagaOrchestrator({
    db,
    config,
    getProvider,
    emitEvent,
    sagaOptions: opts.sagaOptions
  });

  const previousApprovalAlerts = new Set<string>();

  const syncRemoteSessions = (remoteSessions: SessionRecord[]): void => {
    for (const rs of remoteSessions) {
      const existing = db.getSession(rs.id);
      if (existing && existing.state === 'HANDING_OFF' && rs.state !== 'HANDED_OFF') {
        continue;
      }
      const changed =
        !existing ||
        existing.state !== rs.state ||
        existing.latestSummary !== rs.latestSummary ||
        existing.externalSessionId !== rs.externalSessionId;
      db.upsertSession(rs);
      if (changed) {
        emitEvent({ type: 'session_update', session: rs });
      }
      if (rs.state === 'WAITING_APPROVAL' && rs.approvalPrompt) {
        const key = `${rs.id}:${rs.approvalPrompt}`;
        if (!previousApprovalAlerts.has(key)) {
          previousApprovalAlerts.add(key);
          emitEvent({
            type: 'approval_alert',
            session: rs,
            prompt: rs.approvalPrompt
          });
        }
      }
    }
  };

  let polling = false;
  const pollOnce = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const localNode = await localProvider.probe();
      emitEvent({ type: 'node_update', node: localNode });
      const localSessions = await localProvider.listSessions();
      for (const ls of localSessions) {
        emitEvent({ type: 'session_update', session: ls });
        if (ls.state === 'WAITING_APPROVAL' && ls.approvalPrompt) {
          const key = `${ls.id}:${ls.approvalPrompt}`;
          if (!previousApprovalAlerts.has(key)) {
            previousApprovalAlerts.add(key);
            emitEvent({
              type: 'approval_alert',
              session: ls,
              prompt: ls.approvalPrompt
            });
          }
        }
      }

      try {
        const remoteNode = await companionProvider.probe();
        db.upsertNode(remoteNode);
        emitEvent({ type: 'node_update', node: remoteNode });
        const remoteSessions = await companionProvider.listSessions();
        syncRemoteSessions(remoteSessions);
      } catch {
        const cached = db.getNode(config.companionNodeId);
        if (cached && cached.status !== 'OFFLINE') {
          const offlineNode: NodeInfo = { ...cached, status: 'OFFLINE' };
          db.upsertNode(offlineNode);
          emitEvent({ type: 'node_update', node: offlineNode });
        }
      }
    } finally {
      polling = false;
    }
  };

  // Initial probe of local node
  await localProvider.probe();

  const app = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Auth middleware for /api/* and /ws/* (except /api/health)
  app.addHook('onRequest', async (req, reply) => {
    if (!config.authToken) return;
    const isProtected =
      (req.url.startsWith('/api/') && !req.url.startsWith('/api/health')) ||
      req.url.startsWith('/ws/');
    if (!isProtected) return;
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
    const statusCode =
      typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(statusCode).send({ code: 'INTERNAL_ERROR', message });
  });

  // ---- REST API ----

  app.get('/api/health', async () => ({
    ok: true,
    role: 'hub',
    nodeId: config.nodeId,
    defaultNodeId: config.nodeId,
    timestamp: new Date().toISOString()
  }));

  app.get('/api/nodes', async () => {
    await pollOnce();
    return db.listNodes();
  });

  app.get('/api/workspaces', async (req) => {
    const q = req.query as { nodeId?: string };
    const nodeId = q.nodeId || config.nodeId;
    return getProvider(nodeId).listWorkspaces();
  });

  app.get('/api/sessions', async (req) => {
    const q = req.query as { nodeId?: string; agent?: string };
    const agent = q.agent ? AgentKindSchema.parse(q.agent) : undefined;
    return db.listSessions({ nodeId: q.nodeId, agent });
  });

  app.get('/api/sessions/discovered', async (req) => {
    const q = req.query as { nodeId?: string; agent?: string; limit?: string };
    const nodeId = q.nodeId || config.nodeId;
    const agent = q.agent ? AgentKindSchema.parse(q.agent) : undefined;
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 50;
    return getProvider(nodeId).discoverSessions(agent, limit);
  });

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const session = db.getSession(id);
    if (!session) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${id}`, 404);
    }
    return session;
  });

  app.get('/api/sessions/:id/progress', async (req) => {
    const { id } = req.params as { id: string };
    const session = db.getSession(id);
    if (!session) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${id}`, 404);
    }
    const snap = await getProvider(session.nodeId).getProgress(id);
    const updated = {
      ...session,
      state: snap.state,
      latestSummary: snap.summary || session.latestSummary,
      approvalPrompt: snap.approvalPrompt,
      updatedAt: new Date().toISOString()
    };
    db.upsertSession(updated);
    return snap;
  });

  app.post('/api/sessions/start', async (req) => {
    const parsed = StartSessionRequestSchema.parse(req.body);
    const targetNodeId = parsed.nodeId || config.nodeId;
    const provider = getProvider(targetNodeId);
    const session = await provider.startSession({ ...parsed, nodeId: targetNodeId });
    db.upsertSession(session);
    emitEvent({ type: 'session_update', session });
    return session;
  });

  app.post('/api/sessions/resume', async (req) => {
    const parsed = ResumeSessionRequestSchema.parse(req.body);
    const targetNodeId = parsed.nodeId || config.nodeId;
    const provider = getProvider(targetNodeId);
    const session = await provider.resumeSession({ ...parsed, nodeId: targetNodeId });
    db.upsertSession(session);
    emitEvent({ type: 'session_update', session });
    return session;
  });

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { purge?: string };
    const session = db.getSession(id);
    if (!session) {
      throw new AgentHubError('SESSION_NOT_FOUND', `Session not found: ${id}`, 404);
    }
    const purge = q.purge === '1';
    await getProvider(session.nodeId).stopSession(id, purge);
    if (purge) {
      db.deleteSession(id);
    } else {
      const updated: SessionRecord = {
        ...session,
        state: 'EXITED',
        updatedAt: new Date().toISOString()
      };
      db.upsertSession(updated);
      emitEvent({ type: 'session_update', session: updated });
    }
    return { ok: true };
  });

  app.get('/api/handoffs', async (req) => {
    const q = req.query as { limit?: string };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 50;
    return db.listHandoffJobs(limit);
  });

  app.get('/api/handoffs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = db.getHandoffJob(id);
    if (!job) {
      throw new AgentHubError('NOT_FOUND', `Handoff job not found: ${id}`, 404);
    }
    return job;
  });

  app.post('/api/handoffs', async (req) => {
    const parsed = HandoffRequestSchema.parse(req.body);
    return saga.startHandoff(parsed);
  });

  app.post('/api/handoffs/batch', async (req) => {
    const parsed = BatchHandoffRequestSchema.parse(req.body ?? {});
    return saga.startBatchHandoff(parsed);
  });

  app.post('/api/handoffs/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    return saga.retryHandoff(id);
  });

  // ---- WebSockets ----

  app.get('/ws/events', { websocket: true }, (socket) => {
    wsClients.add(socket);
    const snapshot: HubEventMessage = {
      type: 'snapshot',
      nodes: db.listNodes(),
      sessions: db.listSessions(),
      handoffs: db.listHandoffJobs(50)
    };
    socket.send(JSON.stringify(snapshot));

    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  app.get('/ws/sessions/:id/pty', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const session = db.getSession(id);
    if (!session) {
      socket.send(
        JSON.stringify({
          type: 'status',
          state: 'ERROR',
          message: `Session not found: ${id}`
        })
      );
      socket.close();
      return;
    }
    const q = req.query as { cols?: string; rows?: string };
    const cols = q.cols ? Number(q.cols) : 120;
    const rows = q.rows ? Number(q.rows) : 36;
    getProvider(session.nodeId).attachPty(id, socket, cols, rows);
  });

  // ---- Static Web UI ----
  const webDistDir = resolveWebDistDir(opts.webDistDir);
  if (webDistDir) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/'
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const pollInterval = opts.pollIntervalMs ?? 2500;
  let timer: NodeJS.Timeout | null = null;
  if (pollInterval > 0) {
    timer = setInterval(() => {
      void pollOnce().catch(() => {});
    }, pollInterval);
    timer.unref();
  }

  return {
    app,
    db,
    localProvider,
    companionProvider,
    saga,
    pollOnce,
    async close() {
      if (timer) clearInterval(timer);
      for (const c of wsClients) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
      await app.close();
      db.close();
    }
  };
}
