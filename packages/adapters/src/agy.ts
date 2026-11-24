import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  AgentHubError,
  rewriteFileUriArrayJson,
  rewritePath,
  type AgentProbeResult,
  type DiscoveredSession,
  type ImportBundleResult,
  type PathMappingRule,
  type ProgressEventItem,
  type ProgressSnapshot,
  type ResumeSessionRequest,
  type SessionBundleManifest,
  type SessionRecord,
  type SessionState,
  type StartSessionRequest
} from '@agent-hub/protocol';
import {
  buildShellInvocation,
  copyDirectoryRecursive,
  detectApprovalPrompt,
  findBinary,
  getBinaryVersion,
  mapPermissionFlags,
  readJsonlLines,
  type AdapterOptions,
  type AgentAdapter,
  type CommandInvocation
} from './base.js';

const execFileAsync = promisify(execFile);

const SUMMARIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id text,
  title text NOT NULL DEFAULT '',
  preview text NOT NULL DEFAULT '',
  step_count integer NOT NULL DEFAULT 0,
  last_modified_time datetime NOT NULL,
  workspace_uris text NOT NULL,
  status text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  parent_conversation_id text NOT NULL DEFAULT '',
  nesting_depth integer NOT NULL DEFAULT 0,
  battle_id text NOT NULL DEFAULT '',
  winning_conversation_id text NOT NULL DEFAULT '',
  not_fully_idle numeric NOT NULL DEFAULT false,
  killed numeric NOT NULL DEFAULT false,
  last_user_input_time datetime NOT NULL,
  last_user_input_step_index integer NOT NULL DEFAULT -1,
  app_data_dir text NOT NULL DEFAULT '',
  raw_summary blob,
  group_id text NOT NULL DEFAULT '',
  PRIMARY KEY (conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_last_user_input_time
  ON conversation_summaries(last_user_input_time);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_last_modified_time
  ON conversation_summaries(last_modified_time);
`;

const SUMMARY_COLUMNS = [
  'conversation_id',
  'title',
  'preview',
  'step_count',
  'last_modified_time',
  'workspace_uris',
  'status',
  'source',
  'project_id',
  'agent_name',
  'parent_conversation_id',
  'nesting_depth',
  'battle_id',
  'winning_conversation_id',
  'not_fully_idle',
  'killed',
  'last_user_input_time',
  'last_user_input_step_index',
  'app_data_dir',
  'raw_summary',
  'group_id'
] as const;

function parseWorkspaceUris(rawJson: string): string {
  if (!rawJson || !rawJson.trim()) return '';
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return '';
    for (const item of parsed) {
      if (typeof item === 'string') {
        if (item.startsWith('file://')) {
          return decodeURIComponent(item.slice('file://'.length));
        }
        if (item.startsWith('/')) return item;
      }
    }
    return '';
  } catch {
    return '';
  }
}

function toIsoDate(val: unknown): string {
  if (typeof val === 'string' && val.trim()) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return val;
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const ms = val > 1e12 ? val : val * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

async function safeSqliteBackup(srcPath: string, destPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });

  try {
    const db = new DatabaseSync(srcPath, { readOnly: true });
    try {
      await backup(db, destPath);
      return;
    } finally {
      db.close();
    }
  } catch {
    // Fallback to sqlite3 CLI `.backup`
    try {
      const escaped = destPath.replace(/'/g, "''");
      await execFileAsync('sqlite3', [srcPath, `.backup '${escaped}'`], {
        timeout: 10000
      });
    } catch (err) {
      throw new AgentHubError(
        'BUNDLE_EXPORT_FAILED',
        `SQLite safe backup failed for ${srcPath}: ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
  }
}

function serializeSqlRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
      out[k] = { __base64: Buffer.from(v).toString('base64') };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function deserializeSqlValue(v: unknown): string | number | bigint | Uint8Array | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && '__base64' in (v as Record<string, unknown>)) {
    const b64 = (v as { __base64: string }).__base64;
    return Buffer.from(b64, 'base64');
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
    return v;
  }
  return String(v);
}

export class AgyAdapter implements AgentAdapter {
  public readonly kind = 'agy' as const;
  private readonly opts: AdapterOptions;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  private getAntigravityRoot(): string {
    return path.join(this.opts.homeDir, '.gemini', 'antigravity');
  }

  private getSummariesDbPath(): string {
    return path.join(this.getAntigravityRoot(), 'conversation_summaries.db');
  }

  private getConversationDbPath(id: string): string {
    return path.join(this.getAntigravityRoot(), 'conversations', `${id}.db`);
  }

  private getBrainDir(id: string): string {
    return path.join(this.getAntigravityRoot(), 'brain', id);
  }

  async probe(): Promise<AgentProbeResult> {
    const binaryPath = await findBinary('agy', this.opts.config?.binary, this.opts.homeDir);
    const version = binaryPath ? await getBinaryVersion(binaryPath) : null;
    const sessionDir = this.getAntigravityRoot();
    let sessionDirReadable = false;
    try {
      if (fs.existsSync(sessionDir)) {
        fs.accessSync(sessionDir, fs.constants.R_OK);
        sessionDirReadable = true;
      }
    } catch {
      sessionDirReadable = false;
    }
    return {
      kind: 'agy',
      installed: Boolean(binaryPath),
      binaryPath,
      version,
      sessionDir,
      sessionDirReadable
    };
  }

  async discoverSessions(limit = 50): Promise<DiscoveredSession[]> {
    const dbPath = this.getSummariesDbPath();
    if (!fs.existsSync(dbPath)) return [];

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  workspace_uris, status, not_fully_idle, killed
           FROM conversation_summaries
           ORDER BY last_modified_time DESC
           LIMIT ?`
        )
        .all(limit) as Record<string, unknown>[];

      return rows.map((row) => {
        const id = String(row.conversation_id ?? '');
        const cwd = parseWorkspaceUris(String(row.workspace_uris ?? ''));
        const status = String(row.status ?? '');
        const notFullyIdle = Number(row.not_fully_idle ?? 0) === 1;
        const killed = Number(row.killed ?? 0) === 1;

        let stateHint: SessionState = 'IDLE';
        if (killed) stateHint = 'EXITED';
        else if (status.includes('RUNNING') || notFullyIdle) stateHint = 'RUNNING';

        return {
          agent: 'agy',
          externalSessionId: id,
          title: String(row.title ?? '') || id.slice(0, 8),
          preview: String(row.preview ?? '') || '(antigravity session)',
          cwd,
          filePath: this.getConversationDbPath(id),
          stateHint,
          updatedAt: toIsoDate(row.last_modified_time),
          stepCount: Number(row.step_count ?? 0)
        };
      });
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close error
      }
    }
  }

  async findLatestSessionForCwd(
    cwd: string,
    sinceMs = 0
  ): Promise<DiscoveredSession | null> {
    const all = await this.discoverSessions(60);
    const normTarget = path.posix.normalize(cwd).replace(/\/+$/, '');
    const candidates = all.filter((s) => {
      const updatedMs = new Date(s.updatedAt).getTime();
      if (updatedMs < sinceMs) return false;
      if (!s.cwd) return true;
      const normS = path.posix.normalize(s.cwd).replace(/\/+$/, '');
      return normS === normTarget;
    });
    return candidates[0] ?? null;
  }

  buildStartCommand(req: StartSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'agy';
    const permArgs = mapPermissionFlags('agy', req.permissionMode ?? 'default');
    const args: string[] = [...(this.opts.config?.defaultArgs ?? []), ...permArgs];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);
    if (req.initialPrompt) args.push('-i', req.initialPrompt);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? false,
        shellFunctionName: 'agy',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  buildResumeCommand(req: ResumeSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'agy';
    const permArgs = mapPermissionFlags('agy', req.permissionMode ?? 'default');
    const args: string[] = [
      ...(this.opts.config?.defaultArgs ?? []),
      '--conversation',
      req.externalSessionId,
      ...permArgs
    ];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? false,
        shellFunctionName: 'agy',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  buildFallbackResumeCommand(req: ResumeSessionRequest): CommandInvocation | null {
    if (!req.fallbackContextFile) return null;
    const bin = this.opts.config?.binary?.trim() || 'agy';
    const permArgs = mapPermissionFlags('agy', req.permissionMode ?? 'default');
    const prompt =
      req.continuationPrompt
        ? `${req.continuationPrompt}\n\n请先读取迁移上下文文件：${req.fallbackContextFile}`
        : `请先读取迁移上下文文件 ${req.fallbackContextFile} 了解前序对话历史与产物，然后继续协助用户。`;
    const args: string[] = [
      ...(this.opts.config?.defaultArgs ?? []),
      ...permArgs
    ];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);
    args.push('-i', prompt);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? false,
        shellFunctionName: 'agy',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  async observeProgress(
    session: SessionRecord,
    ptyTail: string,
    processAlive: boolean
  ): Promise<ProgressSnapshot> {
    const events: ProgressEventItem[] = [];
    let summary = session.latestSummary;
    let stepCount = 0;
    let summaryRunning = false;

    if (session.externalSessionId) {
      const dbPath = this.getSummariesDbPath();
      if (fs.existsSync(dbPath)) {
        let db: DatabaseSync | null = null;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true });
          const row = db
            .prepare(
              `SELECT title, preview, step_count, status, not_fully_idle, last_modified_time
               FROM conversation_summaries WHERE conversation_id = ?`
            )
            .get(session.externalSessionId) as Record<string, unknown> | undefined;
          if (row) {
            stepCount = Number(row.step_count ?? 0);
            const preview = String(row.preview ?? '');
            if (preview) summary = preview;
            summaryRunning =
              String(row.status ?? '').includes('RUNNING') ||
              Number(row.not_fully_idle ?? 0) === 1;
          }
        } catch {
          // ignore transient lock
        } finally {
          try {
            db?.close();
          } catch {
            // ignore
          }
        }
      }

      const transcriptPath = path.join(
        this.getBrainDir(session.externalSessionId),
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (fs.existsSync(transcriptPath)) {
        const data = readJsonlLines(transcriptPath, 40);
        for (const obj of data.lines) {
          const stepType = String(obj.type ?? obj.source ?? 'STEP');
          const text = String(obj.content ?? '');
          if (text.trim()) {
            events.push({
              timestamp:
                typeof obj.created_at === 'string'
                  ? obj.created_at
                  : new Date().toISOString(),
              kind: stepType === 'USER_INPUT' ? 'user' : 'assistant',
              title: stepType,
              detail: text.slice(0, 200)
            });
          }
        }
        if (!summary && events.length > 0) {
          summary = events[events.length - 1].detail;
        }
      }
    }

    let state: SessionState;
    let approvalPrompt: string | null = null;

    if (!processAlive) {
      state = session.state === 'HANDED_OFF' ? 'HANDED_OFF' : 'EXITED';
    } else {
      approvalPrompt = detectApprovalPrompt(ptyTail);
      if (approvalPrompt) {
        state = 'WAITING_APPROVAL';
      } else if (summaryRunning) {
        state = 'RUNNING';
      } else {
        state = 'IDLE';
      }
    }

    return {
      sessionId: session.id,
      state,
      summary: summary || session.title,
      approvalPrompt,
      stepCount: stepCount || events.length,
      events: events.slice(-15),
      ptyTail,
      observedAt: new Date().toISOString()
    };
  }

  private buildFallbackMarkdown(opts: {
    id: string;
    cwd: string;
    title: string;
    summaryRow: Record<string, unknown> | null;
    brainDir: string;
  }): string {
    const lines: string[] = [
      `# Antigravity Handoff Fallback Context`,
      ``,
      `- **Conversation ID**: \`${opts.id}\``,
      `- **Original Workspace**: \`${opts.cwd}\``,
      `- **Title**: ${opts.title}`,
      ``
    ];

    if (opts.summaryRow) {
      lines.push(
        `## Summary`,
        `- Steps: ${String(opts.summaryRow.step_count ?? 0)}`,
        `- Preview: ${String(opts.summaryRow.preview ?? '')}`,
        ``
      );
    }

    if (fs.existsSync(opts.brainDir)) {
      const mdFiles = fs
        .readdirSync(opts.brainDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .slice(0, 5);
      for (const file of mdFiles) {
        try {
          const content = fs.readFileSync(path.join(opts.brainDir, file.name), 'utf8');
          lines.push(`## Brain Artifact: ${file.name}`, ``, content.slice(0, 4000), ``);
        } catch {
          // ignore unreadable artifact
        }
      }

      const transcriptPath = path.join(
        opts.brainDir,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (fs.existsSync(transcriptPath)) {
        const data = readJsonlLines(transcriptPath, 20);
        if (data.lines.length > 0) {
          lines.push(`## Recent Conversation Turns`, ``);
          for (const item of data.lines) {
            const type = String(item.type ?? 'STEP');
            const text = String(item.content ?? '').slice(0, 500);
            if (text) {
              lines.push(`- **[${type}]** ${text}`);
            }
          }
        }
      }
    }

    return lines.join('\n');
  }

  async exportBundle(
    session: {
      externalSessionId: string;
      sessionFilePath?: string | null;
      cwd: string;
      title?: string;
    },
    stagingDir: string
  ): Promise<SessionBundleManifest> {
    const id = session.externalSessionId;
    const convDbPath = this.getConversationDbPath(id);
    const brainDir = this.getBrainDir(id);
    const summariesDbPath = this.getSummariesDbPath();

    const files: string[] = [];
    fs.mkdirSync(stagingDir, { recursive: true });

    if (!fs.existsSync(convDbPath) && !fs.existsSync(brainDir)) {
      throw new AgentHubError(
        'BUNDLE_EXPORT_FAILED',
        `Antigravity conversation not found: ${id}`,
        404
      );
    }

    if (fs.existsSync(convDbPath)) {
      const destDb = path.join(stagingDir, `${id}.db`);
      await safeSqliteBackup(convDbPath, destDb);
      files.push(`${id}.db`);
    }

    if (fs.existsSync(brainDir)) {
      copyDirectoryRecursive(brainDir, path.join(stagingDir, 'brain', id));
      files.push(`brain/${id}`);
    }

    let summaryRow: Record<string, unknown> | null = null;
    if (fs.existsSync(summariesDbPath)) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(summariesDbPath, { readOnly: true });
        const row = db
          .prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?')
          .get(id) as Record<string, unknown> | undefined;
        if (row) {
          summaryRow = serializeSqlRow(row);
          fs.writeFileSync(
            path.join(stagingDir, 'summary_row.json'),
            JSON.stringify(summaryRow, null, 2),
            'utf8'
          );
          files.push('summary_row.json');
        }
      } finally {
        try {
          db?.close();
        } catch {
          // ignore
        }
      }
    }

    const fallbackMd = this.buildFallbackMarkdown({
      id,
      cwd: session.cwd,
      title: String(summaryRow?.title ?? session.title ?? id),
      summaryRow,
      brainDir
    });
    fs.writeFileSync(path.join(stagingDir, 'fallback_context.md'), fallbackMd, 'utf8');
    files.push('fallback_context.md');

    const manifest: SessionBundleManifest = {
      version: 1,
      agent: 'agy',
      externalSessionId: id,
      sourceHome: this.opts.homeDir,
      sourceCwd: session.cwd,
      title: String(summaryRow?.title ?? session.title ?? id),
      createdAt: new Date().toISOString(),
      files,
      metadata: {
        hasConversationDb: fs.existsSync(convDbPath),
        hasBrainDir: fs.existsSync(brainDir),
        hasSummaryRow: summaryRow !== null
      }
    };
    fs.writeFileSync(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
    return manifest;
  }

  async importBundle(
    manifest: SessionBundleManifest,
    extractedDir: string,
    rule: PathMappingRule
  ): Promise<ImportBundleResult> {
    const id = manifest.externalSessionId;
    const warnings: string[] = [];

    const convsDir = path.join(this.getAntigravityRoot(), 'conversations');
    const targetBrainDir = this.getBrainDir(id);
    fs.mkdirSync(convsDir, { recursive: true });

    let targetConvDbPath: string | null = null;
    const srcConvDb = path.join(extractedDir, `${id}.db`);
    if (fs.existsSync(srcConvDb)) {
      targetConvDbPath = path.join(convsDir, `${id}.db`);
      // Remove stale WAL/SHM before replacing main db
      for (const suffix of ['', '-wal', '-shm']) {
        const p = `${targetConvDbPath}${suffix}`;
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
      fs.copyFileSync(srcConvDb, targetConvDbPath);
    } else {
      warnings.push(`Conversation DB ${id}.db absent in bundle`);
    }

    const srcBrain = path.join(extractedDir, 'brain', id);
    if (fs.existsSync(srcBrain)) {
      copyDirectoryRecursive(srcBrain, targetBrainDir);
    }

    const srcSummaryPath = path.join(extractedDir, 'summary_row.json');
    if (fs.existsSync(srcSummaryPath)) {
      const row = JSON.parse(
        fs.readFileSync(srcSummaryPath, 'utf8')
      ) as Record<string, unknown>;

      const rewrittenUris =
        typeof row.workspace_uris === 'string' && row.workspace_uris.trim()
          ? rewriteFileUriArrayJson(row.workspace_uris, rule)
          : JSON.stringify([`file://${rule.targetCwd}`]);
      row.workspace_uris = rewrittenUris;

      if (typeof row.app_data_dir === 'string' && row.app_data_dir.startsWith('/')) {
        row.app_data_dir = rewritePath(row.app_data_dir, rule);
      }

      const summariesDbPath = this.getSummariesDbPath();
      fs.mkdirSync(path.dirname(summariesDbPath), { recursive: true });
      const db = new DatabaseSync(summariesDbPath);
      try {
        db.exec(SUMMARIES_SCHEMA_SQL);
        const placeholders = SUMMARY_COLUMNS.map(() => '?').join(', ');
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO conversation_summaries (${SUMMARY_COLUMNS.join(', ')}) VALUES (${placeholders})`
        );
        const values = SUMMARY_COLUMNS.map((col) => {
          if (col === 'conversation_id') return id;
          if (col === 'last_modified_time' && !row[col]) return new Date().toISOString();
          if (col === 'last_user_input_time' && !row[col]) return new Date().toISOString();
          if (col === 'workspace_uris') return rewrittenUris;
          return deserializeSqlValue(row[col] ?? (col === 'step_count' || col === 'nesting_depth' || col === 'not_fully_idle' || col === 'killed' ? 0 : col === 'last_user_input_step_index' ? -1 : ''));
        });
        stmt.run(...values);
      } finally {
        db.close();
      }
    }

    let fallbackContextFile: string | null = null;
    const srcFallback = path.join(extractedDir, 'fallback_context.md');
    if (fs.existsSync(srcFallback)) {
      const fallbackDir = path.join(this.opts.dataDir, 'handoff-contexts', id);
      fs.mkdirSync(fallbackDir, { recursive: true });
      fallbackContextFile = path.join(fallbackDir, 'fallback_context.md');
      fs.copyFileSync(srcFallback, fallbackContextFile);
    }

    return {
      externalSessionId: id,
      targetSessionFilePath: targetConvDbPath,
      fallbackContextFile,
      warnings
    };
  }
}
