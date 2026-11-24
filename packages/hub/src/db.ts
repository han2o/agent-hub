import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentKind,
  AgentProbeResult,
  HandoffJobRecord,
  HandoffStatus,
  HandoffStepName,
  HandoffStepRecord,
  NodeInfo,
  NodeRole,
  NodeStatus,
  PermissionMode,
  RepoInfo,
  SessionRecord,
  SessionSourceType,
  SessionState
} from '@agent-hub/protocol';

const HUB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  os TEXT NOT NULL,
  home_dir TEXT NOT NULL,
  workspace_roots_json TEXT NOT NULL,
  worktrees_root TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  agents_json TEXT NOT NULL,
  repos_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  external_session_id TEXT,
  session_file_path TEXT,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  git_origin TEXT,
  git_branch TEXT,
  tmux_name TEXT NOT NULL,
  pid INTEGER,
  permission_mode TEXT NOT NULL,
  cli_args_json TEXT NOT NULL,
  model TEXT,
  state TEXT NOT NULL,
  source_type TEXT NOT NULL,
  latest_summary TEXT NOT NULL,
  approval_prompt TEXT,
  handed_off_to_session_id TEXT,
  handed_off_from_session_id TEXT,
  worktree_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hub_sessions_node ON sessions(node_id);
CREATE INDEX IF NOT EXISTS idx_hub_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS session_leases (
  session_id TEXT PRIMARY KEY,
  holder_node_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoff_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  source_session_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  target_session_id TEXT,
  agent TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  source_state_at_freeze TEXT NOT NULL,
  wip_branch TEXT,
  commit_sha TEXT,
  source_cwd TEXT NOT NULL,
  target_cwd TEXT,
  worktree_created INTEGER NOT NULL DEFAULT 0,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_jobs_created ON handoff_jobs(created_at);

CREATE TABLE IF NOT EXISTS handoff_steps (
  job_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  message TEXT NOT NULL DEFAULT '',
  stdout_tail TEXT NOT NULL DEFAULT '',
  stderr_tail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (job_id, step_name),
  FOREIGN KEY (job_id) REFERENCES handoff_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  session_id TEXT,
  job_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function rowToNode(row: Record<string, unknown>): NodeInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role) as NodeRole,
    os: String(row.os),
    homeDir: String(row.home_dir),
    workspaceRoots: JSON.parse(String(row.workspace_roots_json || '[]')) as string[],
    worktreesRoot: String(row.worktrees_root),
    status: String(row.status) as NodeStatus,
    lastSeenAt: String(row.last_seen_at),
    agents: JSON.parse(String(row.agents_json || '[]')) as AgentProbeResult[],
    repos: JSON.parse(String(row.repos_json || '[]')) as RepoInfo[]
  };
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    agent: String(row.agent) as AgentKind,
    externalSessionId: row.external_session_id ? String(row.external_session_id) : null,
    sessionFilePath: row.session_file_path ? String(row.session_file_path) : null,
    title: String(row.title),
    cwd: String(row.cwd),
    gitOrigin: row.git_origin ? String(row.git_origin) : null,
    gitBranch: row.git_branch ? String(row.git_branch) : null,
    tmuxName: String(row.tmux_name),
    pid: row.pid !== null && row.pid !== undefined ? Number(row.pid) : null,
    permissionMode: String(row.permission_mode) as PermissionMode,
    cliArgs: JSON.parse(String(row.cli_args_json || '[]')) as string[],
    model: row.model ? String(row.model) : null,
    state: String(row.state) as SessionState,
    sourceType: String(row.source_type) as SessionSourceType,
    latestSummary: String(row.latest_summary || ''),
    approvalPrompt: row.approval_prompt ? String(row.approval_prompt) : null,
    handedOffToSessionId: row.handed_off_to_session_id
      ? String(row.handed_off_to_session_id)
      : null,
    handedOffFromSessionId: row.handed_off_from_session_id
      ? String(row.handed_off_from_session_id)
      : null,
    worktreePath: row.worktree_path ? String(row.worktree_path) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToStep(row: Record<string, unknown>): HandoffStepRecord {
  return {
    jobId: String(row.job_id),
    stepName: String(row.step_name) as HandoffStepName,
    status: String(row.status) as HandoffStatus,
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    message: String(row.message || ''),
    stdoutTail: String(row.stdout_tail || ''),
    stderrTail: String(row.stderr_tail || '')
  };
}

export class HubDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(HUB_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  upsertNode(node: NodeInfo): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO nodes (
          id, name, role, os, home_dir, workspace_roots_json, worktrees_root,
          status, last_seen_at, agents_json, repos_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.name,
        node.role,
        node.os,
        node.homeDir,
        JSON.stringify(node.workspaceRoots),
        node.worktreesRoot,
        node.status,
        node.lastSeenAt,
        JSON.stringify(node.agents),
        JSON.stringify(node.repos ?? [])
      );
  }

  getNode(id: string): NodeInfo | null {
    const row = this.db
      .prepare('SELECT * FROM nodes WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToNode(row) : null;
  }

  listNodes(): NodeInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes ORDER BY role DESC, id ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  upsertSession(s: SessionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (
          id, node_id, agent, external_session_id, session_file_path, title,
          cwd, git_origin, git_branch, tmux_name, pid, permission_mode,
          cli_args_json, model, state, source_type, latest_summary,
          approval_prompt, handed_off_to_session_id, handed_off_from_session_id,
          worktree_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id,
        s.nodeId,
        s.agent,
        s.externalSessionId,
        s.sessionFilePath,
        s.title,
        s.cwd,
        s.gitOrigin,
        s.gitBranch,
        s.tmuxName,
        s.pid,
        s.permissionMode,
        JSON.stringify(s.cliArgs),
        s.model,
        s.state,
        s.sourceType,
        s.latestSummary,
        s.approvalPrompt,
        s.handedOffToSessionId,
        s.handedOffFromSessionId,
        s.worktreePath,
        s.createdAt,
        s.updatedAt
      );
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(filter?: { nodeId?: string; agent?: AgentKind }): SessionRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter?.nodeId) {
      clauses.push('node_id = ?');
      args.push(filter.nodeId);
    }
    if (filter?.agent) {
      clauses.push('agent = ?');
      args.push(filter.agent);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  acquireLease(
    sessionId: string,
    holderNodeId: string,
    jobId: string,
    ttlMs = 10 * 60 * 1000
  ): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT * FROM session_leases WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined;
      if (existing) {
        const exp = new Date(String(existing.expires_at)).getTime();
        if (exp > now.getTime() && String(existing.job_id) !== jobId) {
          this.db.exec('ROLLBACK');
          return false;
        }
        this.db
          .prepare(
            'UPDATE session_leases SET holder_node_id = ?, job_id = ?, version = version + 1, expires_at = ? WHERE session_id = ?'
          )
          .run(holderNodeId, jobId, expiresAt, sessionId);
      } else {
        this.db
          .prepare(
            'INSERT INTO session_leases (session_id, holder_node_id, job_id, version, expires_at) VALUES (?, ?, ?, 1, ?)'
          )
          .run(sessionId, holderNodeId, jobId, expiresAt);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }

  releaseLease(sessionId: string, jobId?: string): void {
    if (jobId) {
      this.db
        .prepare('DELETE FROM session_leases WHERE session_id = ? AND job_id = ?')
        .run(sessionId, jobId);
    } else {
      this.db
        .prepare('DELETE FROM session_leases WHERE session_id = ?')
        .run(sessionId);
    }
  }

  upsertHandoffJob(
    job: HandoffJobRecord,
    metadata?: Record<string, unknown>
  ): void {
    this.db
      .prepare(
        `INSERT INTO handoff_jobs (
          id, batch_id, source_session_id, source_node_id, target_node_id,
          target_session_id, agent, phase, status, source_state_at_freeze,
          wip_branch, commit_sha, source_cwd, target_cwd, worktree_created,
          fallback_used, error_code, error_message, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          batch_id = excluded.batch_id,
          target_session_id = excluded.target_session_id,
          phase = excluded.phase,
          status = excluded.status,
          source_state_at_freeze = excluded.source_state_at_freeze,
          wip_branch = excluded.wip_branch,
          commit_sha = excluded.commit_sha,
          target_cwd = excluded.target_cwd,
          worktree_created = excluded.worktree_created,
          fallback_used = excluded.fallback_used,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          metadata_json = CASE
            WHEN ? IS NOT NULL THEN excluded.metadata_json
            ELSE handoff_jobs.metadata_json
          END,
          updated_at = excluded.updated_at`
      )
      .run(
        job.id,
        job.batchId,
        job.sourceSessionId,
        job.sourceNodeId,
        job.targetNodeId,
        job.targetSessionId,
        job.agent,
        job.phase,
        job.status,
        job.sourceStateAtFreeze,
        job.wipBranch,
        job.commitSha,
        job.sourceCwd,
        job.targetCwd,
        job.worktreeCreated ? 1 : 0,
        job.fallbackUsed ? 1 : 0,
        job.errorCode,
        job.errorMessage,
        metadata ? JSON.stringify(metadata) : '{}',
        job.createdAt,
        job.updatedAt,
        metadata ? 1 : null
      );

    for (const step of job.steps) {
      this.upsertHandoffStep(step);
    }
  }

  upsertHandoffStep(step: HandoffStepRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO handoff_steps (
          job_id, step_name, status, started_at, finished_at,
          message, stdout_tail, stderr_tail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        step.jobId,
        step.stepName,
        step.status,
        step.startedAt,
        step.finishedAt,
        step.message,
        step.stdoutTail,
        step.stderrTail
      );
  }

  getHandoffMetadata(jobId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT metadata_json FROM handoff_jobs WHERE id = ?')
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row || !row.metadata_json) return {};
    try {
      return JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  updateHandoffMetadata(jobId: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare('UPDATE handoff_jobs SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify(metadata), jobId);
  }

  private hydrateHandoffRow(row: Record<string, unknown>): HandoffJobRecord {
    const id = String(row.id);
    const stepRows = this.db
      .prepare('SELECT * FROM handoff_steps WHERE job_id = ?')
      .all(id) as Record<string, unknown>[];
    return {
      id,
      batchId: row.batch_id ? String(row.batch_id) : null,
      sourceSessionId: String(row.source_session_id),
      sourceNodeId: String(row.source_node_id),
      targetNodeId: String(row.target_node_id),
      targetSessionId: row.target_session_id ? String(row.target_session_id) : null,
      agent: String(row.agent) as AgentKind,
      phase: String(row.phase) as HandoffStepName,
      status: String(row.status) as HandoffStatus,
      sourceStateAtFreeze: String(row.source_state_at_freeze) as SessionState,
      wipBranch: row.wip_branch ? String(row.wip_branch) : null,
      commitSha: row.commit_sha ? String(row.commit_sha) : null,
      sourceCwd: String(row.source_cwd),
      targetCwd: row.target_cwd ? String(row.target_cwd) : null,
      worktreeCreated: Number(row.worktree_created ?? 0) === 1,
      fallbackUsed: Number(row.fallback_used ?? 0) === 1,
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      steps: stepRows.map(rowToStep),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  getHandoffJob(id: string): HandoffJobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM handoff_jobs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrateHandoffRow(row) : null;
  }

  listHandoffJobs(limit = 50): HandoffJobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM handoff_jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.hydrateHandoffRow(r));
  }

  appendAuditEvent(
    eventType: string,
    payload: Record<string, unknown>,
    ids?: { sessionId?: string; jobId?: string }
  ): void {
    this.db
      .prepare(
        'INSERT INTO audit_events (event_type, session_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        eventType,
        ids?.sessionId ?? null,
        ids?.jobId ?? null,
        JSON.stringify(payload),
        new Date().toISOString()
      );
  }
}
