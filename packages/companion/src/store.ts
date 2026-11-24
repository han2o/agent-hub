import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentKind,
  PermissionMode,
  SessionRecord,
  SessionSourceType,
  SessionState
} from '@agent-hub/protocol';

const SCHEMA_SQL = `
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
CREATE INDEX IF NOT EXISTS idx_companion_sessions_updated ON sessions(updated_at);
`;

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

export class CompanionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
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

  listSessions(): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
